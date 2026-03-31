/**
 * Groovy Interpreter: Evaluates Groovy AST by tree-walking.
 * Variables, control flow, closures are handled here.
 * WebUI.xxx() calls are delegated to the existing ScriptExecutor.
 */
import type {
  GroovyScriptAST,
  GroovyStatement,
  GroovyExpression,
} from '../../shared/types/ast';
import type { BrowserConfig } from '../../shared/types/project';
import type { StepResult, ExecutionResult } from '../../shared/types/execution';
import type { StepCallback, FileResolver } from './executor';
import { ScriptExecutor } from './executor';
import { parseScript } from './parser';
import { mapToPlaywrightCommands } from './commandMapper';
import { preprocessScript } from './preprocessor';
import type { AppiumExecutor } from './appiumExecutor';

// ─── Scope (variable context) ───

class Scope {
  private vars: Map<string, any> = new Map();
  constructor(private parent: Scope | null = null) {}

  get(name: string): any {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined; // Groovy-like: undefined = null
  }

  set(name: string, value: any): void {
    if (!this.vars.has(name) && this.parent?.has(name)) {
      this.parent.set(name, value);
      return;
    }
    this.vars.set(name, value);
  }

  declare(name: string, value: any): void {
    this.vars.set(name, value);
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }

  child(): Scope {
    return new Scope(this);
  }
}

// ─── Sentinel for control flow ───
class ReturnSignal { constructor(public value: any) {} }
class BreakSignal {}
class ContinueSignal {}

// ─── TestObject wrapper ───
class TestObjectWrapper {
  properties: Map<string, { type: string; value: string }> = new Map();

  addProperty(propType: string, _conditionType: any, value: string): void {
    this.properties.set(propType, { type: propType, value });
  }

  getSelector(): string {
    const xpath = this.properties.get('xpath');
    if (xpath) return xpath.value;
    const css = this.properties.get('css');
    if (css) return `css=${css.value}`;
    const id = this.properties.get('id');
    if (id) return `#${id.value}`;
    const name = this.properties.get('name');
    if (name) return `[name="${name.value}"]`;
    // fallback: return first value
    for (const [, prop] of this.properties) return prop.value;
    return '';
  }
}

// ─── Main Interpreter ───

export class GroovyInterpreter {
  private globalScope: Scope;
  private executor: ScriptExecutor;
  private config: BrowserConfig;
  private onStep: StepCallback;
  private fileResolver: FileResolver | null;
  private steps: StepResult[] = [];
  private stepIndex = 0;
  private aborted = false;
  private startedAt = '';
  private appiumExecutor: AppiumExecutor | null = null;

  constructor(
    executor: ScriptExecutor,
    config: BrowserConfig,
    onStep: StepCallback,
    fileResolver?: FileResolver,
    globalVariables?: Record<string, any>,
    appiumExecutor?: AppiumExecutor,
  ) {
    this.executor = executor;
    this.config = config;
    this.onStep = onStep;
    this.fileResolver = fileResolver || null;
    this.appiumExecutor = appiumExecutor || null;
    this.globalScope = new Scope();
    // Set fileResolver on executor so callTestCase works in Groovy mode
    this.executor.setFileResolver(this.fileResolver);
    this.registerBuiltins();
    // Register GlobalVariable from profiles
    if (globalVariables) {
      this.globalScope.declare('GlobalVariable', globalVariables);
    }
  }

  async execute(ast: GroovyScriptAST): Promise<ExecutionResult> {
    this.startedAt = new Date().toISOString();
    this.steps = [];
    this.stepIndex = 0;
    let overallStatus: 'pass' | 'fail' | 'error' = 'pass';

    try {
      for (const stmt of ast.statements) {
        if (this.aborted) { overallStatus = 'error'; break; }
        const result = await this.execStatement(stmt, this.globalScope);
        if (result instanceof ReturnSignal) break;
      }
    } catch (err: any) {
      if (!this.aborted) {
        overallStatus = 'fail';
        const errMsg = err.message || String(err);
        // Add error step
        this.steps.push({
          index: this.stepIndex,
          command: 'Error',
          args: [errMsg],
          status: 'fail',
          duration: 0,
          error: errMsg,
          lineNumber: 0,
        });
        // Report error to UI
        this.onStep({
          step: this.stepIndex,
          total: 0,
          command: `Error: ${errMsg}`,
          status: 'fail',
          lineNumber: 0,
          error: errMsg,
        });
      } else {
        overallStatus = 'error';
      }
    }

    // Clean up browser/appium when interpreter finishes
    await this.executor.closeBrowser();
    if (this.appiumExecutor) {
      await this.appiumExecutor.closeSession();
    }

    // Determine overall status from steps
    if (overallStatus === 'pass' && this.steps.some(s => s.status === 'fail')) {
      overallStatus = 'fail';
    }

    return {
      testCaseId: '',
      testCaseName: '',
      status: overallStatus,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      duration: this.steps.reduce((sum, s) => sum + s.duration, 0),
      steps: this.steps,
    };
  }

  stop(): void {
    this.aborted = true;
    this.executor.stop();
    this.appiumExecutor?.stop();
  }

  // ─── Statement Execution ───

  private async execStatement(stmt: GroovyStatement, scope: Scope): Promise<any> {
    if (this.aborted) return;

    switch (stmt.type) {
      case 'VarDeclaration': {
        const value = stmt.initializer ? await this.evaluate(stmt.initializer, scope) : null;
        scope.declare(stmt.name, value);
        return;
      }

      case 'Assignment': {
        const value = await this.evaluate(stmt.value, scope);
        await this.assignTarget(stmt.target, value, scope);
        return;
      }

      case 'If': {
        const cond = await this.evaluate(stmt.condition, scope);
        if (this.isTruthy(cond)) {
          return this.execBlock(stmt.thenBlock, scope);
        }
        for (const elif of stmt.elseIfBlocks) {
          if (this.isTruthy(await this.evaluate(elif.condition, scope))) {
            return this.execBlock(elif.block, scope);
          }
        }
        if (stmt.elseBlock) {
          return this.execBlock(stmt.elseBlock, scope);
        }
        return;
      }

      case 'For': {
        if (stmt.variant === 'forIn' && stmt.iterable) {
          const iterable = await this.evaluate(stmt.iterable, scope);
          const arr = Array.isArray(iterable) ? iterable : [];
          const childScope = scope.child();
          for (const item of arr) {
            if (this.aborted) break;
            childScope.declare(stmt.variable, item);
            const result = await this.execBlock(stmt.body, childScope);
            if (result instanceof BreakSignal) break;
            if (result instanceof ReturnSignal) return result;
            if (result instanceof ContinueSignal) continue;
          }
        } else if (stmt.variant === 'classic') {
          const childScope = scope.child();
          if (stmt.init) await this.execStatement(stmt.init, childScope);
          while (true) {
            if (this.aborted) break;
            if (stmt.condition) {
              const cond = await this.evaluate(stmt.condition, childScope);
              if (!this.isTruthy(cond)) break;
            }
            const result = await this.execBlock(stmt.body, childScope);
            if (result instanceof BreakSignal) break;
            if (result instanceof ReturnSignal) return result;
            if (stmt.update) await this.evaluate(stmt.update, childScope);
          }
        }
        return;
      }

      case 'While': {
        const childScope = scope.child();
        while (!this.aborted) {
          const cond = await this.evaluate(stmt.condition, childScope);
          if (!this.isTruthy(cond)) break;
          const result = await this.execBlock(stmt.body, childScope);
          if (result instanceof BreakSignal) break;
          if (result instanceof ReturnSignal) return result;
        }
        return;
      }

      case 'TryCatch': {
        try {
          await this.execBlock(stmt.tryBlock, scope);
        } catch (err: any) {
          if (stmt.catchBlock) {
            const childScope = scope.child();
            if (stmt.catchVariable) {
              childScope.declare(stmt.catchVariable, err);
            }
            await this.execBlock(stmt.catchBlock, childScope);
          }
        } finally {
          if (stmt.finallyBlock) {
            await this.execBlock(stmt.finallyBlock, scope);
          }
        }
        return;
      }

      case 'ExpressionStatement':
        return this.evaluate(stmt.expression, scope);

      case 'Comment':
        return;

      case 'Return':
        return new ReturnSignal(stmt.value ? await this.evaluate(stmt.value, scope) : null);
    }
  }

  private async execBlock(stmts: GroovyStatement[], parentScope: Scope): Promise<any> {
    const scope = parentScope.child();
    for (const stmt of stmts) {
      if (this.aborted) return;
      const result = await this.execStatement(stmt, scope);
      if (result instanceof ReturnSignal || result instanceof BreakSignal || result instanceof ContinueSignal) {
        return result;
      }
    }
  }

  // ─── Expression Evaluation ───

  private async evaluate(expr: GroovyExpression, scope: Scope): Promise<any> {
    switch (expr.type) {
      case 'Literal':
        return expr.value;

      case 'Identifier':
        return scope.get(expr.name);

      case 'Binary':
        return this.evalBinary(expr, scope);

      case 'Unary': {
        const operand = await this.evaluate(expr.operand, scope);
        if (expr.operator === '!') return !this.isTruthy(operand);
        if (expr.operator === '-') return -operand;
        return operand;
      }

      case 'Member':
        return this.evalMember(expr, scope);

      case 'Call':
        return this.evalCall(expr, scope);

      case 'Index': {
        const obj = await this.evaluate(expr.object, scope);
        const idx = await this.evaluate(expr.index, scope);
        if (Array.isArray(obj)) return obj[idx];
        if (obj && typeof obj === 'object') return obj[idx];
        return undefined;
      }

      case 'New':
        return this.evalNew(expr, scope);

      case 'Closure':
        return this.createClosure(expr, scope);

      case 'List': {
        const elements = [];
        for (const el of expr.elements) {
          elements.push(await this.evaluate(el, scope));
        }
        return elements;
      }

      case 'Map': {
        const map: Record<string, any> = {};
        for (const entry of expr.entries) {
          const key = await this.evaluate(entry.key, scope);
          map[String(key)] = await this.evaluate(entry.value, scope);
        }
        return map;
      }

      case 'StringInterpolation': {
        let result = '';
        for (const part of expr.parts) {
          if (typeof part === 'string') {
            result += part;
          } else {
            result += String(await this.evaluate(part, scope));
          }
        }
        return result;
      }

      case 'Ternary': {
        const cond = await this.evaluate(expr.condition, scope);
        return this.isTruthy(cond)
          ? this.evaluate(expr.consequent, scope)
          : this.evaluate(expr.alternate, scope);
      }

      case 'Assign': {
        const value = await this.evaluate(expr.value, scope);
        await this.assignTarget(expr.target, value, scope);
        return value;
      }

      case 'Cast':
        // Type casts are mostly no-ops in our interpreter
        return this.evaluate(expr.expression, scope);
    }
  }

  private async evalBinary(expr: { operator: string; left: GroovyExpression; right: GroovyExpression }, scope: Scope): Promise<any> {
    const left = await this.evaluate(expr.left, scope);
    // Short-circuit for && and ||
    if (expr.operator === '&&') return this.isTruthy(left) ? await this.evaluate(expr.right, scope) : left;
    if (expr.operator === '||') return this.isTruthy(left) ? left : await this.evaluate(expr.right, scope);

    const right = await this.evaluate(expr.right, scope);

    switch (expr.operator) {
      case '+':
        if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right);
        return (left as number) + (right as number);
      case '-': return (left as number) - (right as number);
      case '*': return (left as number) * (right as number);
      case '/': return (left as number) / (right as number);
      case '%': return (left as number) % (right as number);
      case '==': return left == right;
      case '!=': return left != right;
      case '<': return left < right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '>=': return left >= right;
      default: return null;
    }
  }

  private async evalMember(expr: { object: GroovyExpression; property: string }, scope: Scope): Promise<any> {
    const obj = await this.evaluate(expr.object, scope);
    return this.resolveMember(obj, expr.property);
  }

  /** Resolve a member/method on an already-evaluated object (no re-evaluation) */
  private resolveMember(obj: any, prop: string): any {
    if (obj == null) return undefined;

    // TestObjectWrapper special handling
    if (obj instanceof TestObjectWrapper) {
      if (prop === 'addProperty') {
        return (...args: any[]) => obj.addProperty(args[0], args[1], args[2]);
      }
    }

    // String methods
    if (typeof obj === 'string') {
      switch (prop) {
        case 'trim': return () => obj.trim();
        case 'length': return obj.length;
        case 'toInteger': return () => parseInt(obj, 10);
        case 'toLong': return () => parseInt(obj, 10);
        case 'toFloat': return () => parseFloat(obj);
        case 'toDouble': return () => parseFloat(obj);
        case 'isInteger': return () => !isNaN(parseInt(obj, 10)) && String(parseInt(obj, 10)) === obj.trim();
        case 'isEmpty': return () => obj.length === 0;
        case 'contains': return (s: string) => obj.includes(s);
        case 'startsWith': return (s: string) => obj.startsWith(s);
        case 'endsWith': return (s: string) => obj.endsWith(s);
        case 'replace': return (a: string, b: string) => obj.replace(a, b);
        case 'replaceAll': return (a: string, b: string) => obj.replace(new RegExp(a, 'g'), b);
        case 'split': return (s: string) => obj.split(s);
        case 'toLowerCase': return () => obj.toLowerCase();
        case 'toUpperCase': return () => obj.toUpperCase();
        case 'substring': return (start: number, end?: number) => obj.substring(start, end);
        case 'matches': return (pattern: string) => new RegExp(pattern).test(obj);
        case 'indexOf': return (s: string) => obj.indexOf(s);
        case 'lastIndexOf': return (s: string) => obj.lastIndexOf(s);
        case 'charAt': return (i: number) => obj.charAt(i);
        case 'equals': return (s: any) => obj === String(s);
        case 'equalsIgnoreCase': return (s: string) => obj.toLowerCase() === s.toLowerCase();
        case 'concat': return (s: string) => obj + s;
      }
    }

    // Array/List methods
    if (Array.isArray(obj)) {
      switch (prop) {
        case 'size': return () => obj.length;
        case 'length': return obj.length;
        case 'isEmpty': return () => obj.length === 0;
        case 'get': return (i: number) => obj[i];
        case 'add': return (item: any) => { obj.push(item); return obj; };
        case 'findAll': return async (closure: Function) => {
          const result = [];
          for (const item of obj) {
            if (this.isTruthy(await closure(item))) result.push(item);
          }
          return result;
        };
        case 'find': return async (closure: Function) => {
          for (const item of obj) {
            if (this.isTruthy(await closure(item))) return item;
          }
          return null;
        };
        case 'each': return async (closure: Function) => {
          for (const item of obj) { await closure(item); }
        };
        case 'collect': return async (closure: Function) => {
          const result = [];
          for (const item of obj) { result.push(await closure(item)); }
          return result;
        };
        case 'first': return () => obj[0];
        case 'last': return () => obj[obj.length - 1];
      }
    }

    // Object property access
    if (typeof obj === 'object' && prop in obj) {
      const val = (obj as any)[prop];
      if (typeof val === 'function') return val.bind(obj);
      return val;
    }

    return undefined;
  }

  private async evalCall(expr: { callee: GroovyExpression; arguments: GroovyExpression[] }, scope: Scope): Promise<any> {
    const args = [];
    for (const a of expr.arguments) {
      args.push(await this.evaluate(a, scope));
    }

    // WebUI.method() calls → delegate to executor pipeline
    if (expr.callee.type === 'Member' && expr.callee.object.type === 'Identifier' && expr.callee.object.name === 'WebUI') {
      return this.executeWebUICall(expr.callee.property, args, scope);
    }

    // Mobile.method() calls → delegate to AppiumExecutor
    if (expr.callee.type === 'Member' && expr.callee.object.type === 'Identifier' && expr.callee.object.name === 'Mobile') {
      return this.executeMobileCall(expr.callee.property, args, scope);
    }

    // Evaluate callee
    let callee: any;
    if (expr.callee.type === 'Member') {
      // obj.method(args) — evaluate object ONCE, then resolve method on it
      const obj = await this.evaluate(expr.callee.object, scope);
      const method = expr.callee.property;
      const fn = this.resolveMember(obj, method);

      if (typeof fn === 'function') {
        return await fn(...args);
      }

      throw new Error(`Cannot call method '${method}' on ${typeof obj}`);
    }

    callee = await this.evaluate(expr.callee, scope);

    if (typeof callee === 'function') {
      return await callee(...args);
    }

    if (expr.callee.type === 'Identifier') {
      throw new Error(`Undefined function: ${expr.callee.name}`);
    }

    throw new Error(`Not a function`);
  }

  private async evalNew(expr: { className: string; arguments: GroovyExpression[] }, scope: Scope): Promise<any> {
    const args = [];
    for (const a of expr.arguments) {
      args.push(await this.evaluate(a, scope));
    }

    switch (expr.className) {
      case 'TestObject':
        return new TestObjectWrapper();

      case 'Random':
        return {
          nextInt: (bound?: number) => bound ? Math.floor(Math.random() * bound) : Math.floor(Math.random() * 2147483647),
        };

      case 'Date':
        return new Date(...(args as []));

      case 'ArrayList':
      case 'LinkedList':
        return [];

      case 'HashMap':
      case 'LinkedHashMap':
        return {};

      default: {
        // Try to construct from scope (user-defined or registered class)
        const klass = scope.get(expr.className);
        if (typeof klass === 'function') {
          return new klass(...args);
        }
        // Return a generic object
        return { _className: expr.className };
      }
    }
  }

  private createClosure(expr: { parameters: string[]; body: GroovyStatement[] }, parentScope: Scope): Function {
    const interpreter = this;
    const params = expr.parameters;
    const body = expr.body;

    return async function (...args: any[]) {
      const closureScope = parentScope.child();
      // If no named params, use 'it' as default
      if (params.length === 0 && args.length > 0) {
        closureScope.declare('it', args[0]);
      } else {
        params.forEach((p, i) => closureScope.declare(p, args[i]));
      }

      let lastValue: any = null;
      for (const stmt of body) {
        const result = await interpreter.execStatement(stmt, closureScope);
        if (result instanceof ReturnSignal) return result.value;
        // In Groovy, the last expression is the implicit return
        // execStatement already evaluates ExpressionStatement and returns the value
        if (stmt.type === 'ExpressionStatement') {
          lastValue = result;
        }
      }
      return lastValue;
    };
  }

  // ─── WebUI Bridge ───

  // ─── Mobile Command Execution ───

  private async executeMobileCall(method: string, args: any[], scope: Scope): Promise<any> {
    // Mobile.callTestCase / WebUI.callTestCase → 파일 읽어서 Groovy로 실행
    if (method === 'callTestCase' && args.length >= 1) {
      return this.executeCallTestCaseGroovy(args[0], scope);
    }

    if (!this.appiumExecutor) {
      throw new Error('Mobile executor is not available. This project may not be configured for mobile testing.');
    }

    // Resolve TestObjectWrapper → selector string
    const resolvedArgs = args.map(a => {
      if (a instanceof TestObjectWrapper) return a.getSelector();
      return a;
    });

    // Extract FailureHandling from last argument
    const { cleanArgs, failureHandling } = this.extractFailureHandling(resolvedArgs);

    const commandLabel = `Mobile.${method}(${cleanArgs.map(a => typeof a === 'string' ? `"${a.length > 30 ? a.substring(0, 30) + '...' : a}"` : String(a)).join(', ')})`;

    this.stepIndex++;
    this.onStep({
      step: this.stepIndex,
      total: 0,
      command: commandLabel,
      status: 'running',
      lineNumber: 0,
    });

    const stepStart = Date.now();

    try {
      const result = await this.appiumExecutor.runMobileCommand(method, cleanArgs, 0, this.onStep);
      const duration = Date.now() - stepStart;

      this.steps.push({
        index: this.stepIndex,
        command: commandLabel,
        args: cleanArgs.map(String),
        status: 'pass',
        duration,
        lineNumber: 0,
      });

      this.onStep({
        step: this.stepIndex,
        total: 0,
        command: commandLabel,
        status: 'pass',
        lineNumber: 0,
        duration,
      });

      return result;
    } catch (err: any) {
      const duration = Date.now() - stepStart;
      const errMsg = err.message || String(err);

      if (failureHandling === 'STOP_ON_FAILURE') {
        this.steps.push({
          index: this.stepIndex,
          command: commandLabel,
          args: cleanArgs.map(String),
          status: 'fail',
          duration,
          error: errMsg,
          lineNumber: 0,
        });
        this.onStep({
          step: this.stepIndex,
          total: 0,
          command: commandLabel,
          status: 'fail',
          lineNumber: 0,
          duration,
          error: errMsg,
        });
        throw err;
      } else {
        // CONTINUE_ON_FAILURE or OPTIONAL
        const status = failureHandling === 'OPTIONAL' ? 'pass' : 'fail';
        this.steps.push({
          index: this.stepIndex,
          command: commandLabel,
          args: cleanArgs.map(String),
          status,
          duration,
          error: errMsg,
          lineNumber: 0,
        });
        this.onStep({
          step: this.stepIndex,
          total: 0,
          command: `[${failureHandling}] ${commandLabel}: ${errMsg}`,
          status,
          lineNumber: 0,
          duration,
        });
        return null;
      }
    }
  }

  private extractFailureHandling(args: any[]): { cleanArgs: any[]; failureHandling: string } {
    const last = args[args.length - 1];
    if (typeof last === 'string' && ['STOP_ON_FAILURE', 'CONTINUE_ON_FAILURE', 'OPTIONAL'].includes(last)) {
      return { cleanArgs: args.slice(0, -1), failureHandling: last };
    }
    return { cleanArgs: args, failureHandling: 'STOP_ON_FAILURE' };
  }

  // ─── callTestCase: 파일 읽어서 Groovy 실행 ───

  private async executeCallTestCaseGroovy(testCasePath: string, scope: Scope): Promise<any> {
    if (!this.fileResolver) {
      throw new Error('파일 리졸버가 없습니다. callTestCase를 실행할 수 없습니다.');
    }

    // 파일 읽기
    let script: string;
    try {
      script = await this.fileResolver(testCasePath);
    } catch (err: any) {
      throw new Error(`테스트 케이스를 찾을 수 없습니다: "${testCasePath}" (${err.message})`);
    }

    // Groovy 파싱 + 실행
    const { stripImports } = require('./preprocessor');
    const { parseGroovyScript } = require('./groovyParser');
    const { cleanScript } = stripImports(script);
    const subAst = parseGroovyScript(cleanScript);

    // 현재 스코프를 유지하면서 서브 스크립트 실행
    for (const stmt of subAst.statements) {
      if (this.aborted) break;
      const result = await this.execStatement(stmt, scope);
      if (result instanceof ReturnSignal) return result.value;
    }
  }

  // ─── WebUI Command Execution ───

  private async executeWebUICall(method: string, args: any[], scope: Scope): Promise<any> {
    // callTestCase → 파일 읽어서 Groovy로 실행
    if (method === 'callTestCase' && args.length >= 1) {
      return this.executeCallTestCaseGroovy(args[0], scope);
    }

    // Resolve TestObjectWrapper → selector string
    const resolvedArgs = args.map(a => {
      if (a instanceof TestObjectWrapper) return a.getSelector();
      return a;
    });

    this.stepIndex++;
    const stepStart = Date.now();
    let stepStatus: 'pass' | 'fail' = 'pass';
    let stepError: string | undefined;
    let returnValue: any = undefined;

    const shortLabel = `WebUI.${method}(${resolvedArgs.map(a => typeof a === 'string' && a.length > 40 ? a.substring(0, 40) + '...' : String(a ?? '')).join(', ')})`;

    this.onStep({
      step: this.stepIndex,
      total: 0,
      command: shortLabel,
      status: 'running',
      lineNumber: 0,
    });

    try {
      // --- Value-returning methods: bypass pipeline, call executor directly ---
      if (method === 'getText' && resolvedArgs.length >= 1) {
        returnValue = await this.executor.getTextContent(String(resolvedArgs[0]), this.config);
      } else if (method === 'getAttribute' && resolvedArgs.length >= 2) {
        // getAttribute(selector, attributeName) — 모바일 WebView면 Appium 사용
        if (this.appiumExecutor) {
          returnValue = await this.appiumExecutor.runMobileCommand('getAttribute', [resolvedArgs[0], resolvedArgs[1]], 0, this.onStep);
        } else {
          await this.executor.launchIfNeeded(this.config);
          const el = await this.executor.findElement(String(resolvedArgs[0]), this.config.timeout);
          returnValue = el ? await el.getAttribute(String(resolvedArgs[1])) : null;
        }
      } else if (method === 'getUrl') {
        await this.executor.launchIfNeeded(this.config);
        returnValue = this.executor.getPageUrl();
      } else if (method === 'getWindowTitle') {
        await this.executor.launchIfNeeded(this.config);
        returnValue = await this.executor.getPageTitle();
      } else if (method === 'getNumberOfTotalOption' && resolvedArgs.length >= 1) {
        await this.executor.launchIfNeeded(this.config);
        const options = await this.executor.findElements(String(resolvedArgs[0]), 'option', this.config.timeout);
        returnValue = options ? options.length : 0;
      } else if (method === 'verifyMatch' && resolvedArgs.length >= 3) {
        // verifyMatch(actual, expected, isRegex) — returns boolean, doesn't throw
        const actual = String(resolvedArgs[0] ?? '');
        const expected = String(resolvedArgs[1] ?? '');
        const isRegex = resolvedArgs[2] === true || resolvedArgs[2] === 'true';
        if (isRegex) {
          returnValue = new RegExp(expected).test(actual);
        } else {
          returnValue = actual === expected;
        }
        if (!returnValue) {
          console.warn(`verifyMatch failed: "${actual}" does not match "${expected}"`);
        }
      } else {
        // --- All other methods: go through pipeline ---
        const argsStr = resolvedArgs.map(a => {
          if (typeof a === 'string') return `"${a.replace(/"/g, '\\"')}"`;
          if (typeof a === 'number') return String(a);
          if (a === null || a === undefined) return '""';
          return `"${String(a)}"`;
        }).join(', ');

        let scriptLine: string;
        if (method === 'callTestCase' && resolvedArgs.length >= 1) {
          scriptLine = `WebUI.callTestCase(findTestCase("${resolvedArgs[0]}"))`;
        } else if (['click', 'doubleClick', 'setText', 'clearText', 'sendKeys',
          'waitForElementPresent', 'waitForElementVisible', 'verifyElementPresent',
          'verifyElementText', 'scrollToElement', 'selectOptionByLabel',
          'switchToFrame', 'selectDate', 'selectRandomDate', 'selectRandomDateAfter',
        ].includes(method) && resolvedArgs.length >= 1) {
          const selector = resolvedArgs[0];
          const restArgs = resolvedArgs.slice(1).map(a =>
            typeof a === 'string' ? `"${a.replace(/"/g, '\\"')}"` : String(a ?? '')
          );
          const allArgs = [`findTestObject("${selector}")`, ...restArgs].join(', ');
          scriptLine = `WebUI.${method}(${allArgs})`;
        } else {
          scriptLine = `WebUI.${method}(${argsStr})`;
        }

        const { cleanScript } = preprocessScript(scriptLine);
        const ast = parseScript(cleanScript);
        const commands = mapToPlaywrightCommands(ast);

        for (const cmd of commands) {
          if (cmd.action === 'comment') continue;
          if (cmd.action === 'close') continue;
          await this.executor.runSingleCommand(cmd, this.config);
        }
      }
    } catch (err: any) {
      stepStatus = 'fail';
      stepError = err.message || String(err);
    }

    const duration = Date.now() - stepStart;
    const commandLabel = `WebUI.${method}(${resolvedArgs.map(a => typeof a === 'string' && a.length > 50 ? a.substring(0, 50) + '...' : String(a ?? '')).join(', ')})`;

    this.steps.push({
      index: this.stepIndex - 1,
      command: commandLabel,
      args: resolvedArgs.map(a => String(a ?? '')),
      status: stepStatus,
      duration,
      error: stepError,
      lineNumber: 0,
    });

    this.onStep({
      step: this.stepIndex,
      total: 0,
      command: commandLabel,
      status: stepStatus,
      lineNumber: 0,
      duration,
      error: stepError,
    });

    if (stepStatus === 'fail') {
      throw new Error(stepError || `WebUI.${method} failed`);
    }

    return returnValue;
  }

  // ─── Assignment Helper ───

  private async assignTarget(target: GroovyExpression, value: any, scope: Scope): Promise<void> {
    if (target.type === 'Identifier') {
      scope.set(target.name, value);
    } else if (target.type === 'Member') {
      const obj = await this.evaluate(target.object, scope);
      if (obj && typeof obj === 'object') {
        (obj as any)[target.property] = value;
      }
    } else if (target.type === 'Index') {
      const obj = await this.evaluate(target.object, scope);
      const idx = await this.evaluate(target.index, scope);
      if (Array.isArray(obj)) obj[idx] = value;
      else if (obj && typeof obj === 'object') (obj as any)[idx] = value;
    }
  }

  // ─── Builtins ───

  private registerBuiltins(): void {
    // println — 별도 step으로 표시
    this.globalScope.declare('println', (msg: any) => {
      this.stepIndex++;
      const label = `println: ${String(msg)}`;
      this.onStep({
        step: this.stepIndex,
        total: 0,
        command: label,
        status: 'pass',
        lineNumber: 0,
      });
      this.steps.push({
        index: this.stepIndex,
        command: label,
        args: [],
        status: 'pass',
        duration: 0,
        lineNumber: 0,
      });
    });

    // findTestObject → returns the path string
    this.globalScope.declare('findTestObject', (path: string) => path);

    // findTestCase → returns the path string
    this.globalScope.declare('findTestCase', (path: string) => path);

    // FailureHandling enum
    this.globalScope.declare('FailureHandling', {
      STOP_ON_FAILURE: 'STOP_ON_FAILURE',
      CONTINUE_ON_FAILURE: 'CONTINUE_ON_FAILURE',
      OPTIONAL: 'OPTIONAL',
    });

    // ConditionType enum
    this.globalScope.declare('ConditionType', {
      EQUALS: 'EQUALS',
      CONTAINS: 'CONTAINS',
      STARTS_WITH: 'STARTS_WITH',
      ENDS_WITH: 'ENDS_WITH',
      MATCHES_REGEX: 'MATCHES_REGEX',
    });

    // KeywordUtil
    this.globalScope.declare('KeywordUtil', {
      markFailed: (msg: string) => {
        throw new Error(`FAILED: ${msg}`);
      },
      markFailedAndStop: (msg: string) => {
        throw new Error(`FAILED_AND_STOP: ${msg}`);
      },
      logInfo: (msg: string) => {
        this.onStep({ step: this.stepIndex, total: 0, command: `[INFO] ${msg}`, status: 'pass', lineNumber: 0 });
      },
    });

    // Integer, String class methods
    this.globalScope.declare('Integer', {
      parseInt: (s: string) => parseInt(s, 10),
      valueOf: (s: string) => parseInt(s, 10),
    });

    // By (Selenium selector)
    this.globalScope.declare('By', {
      xpath: (expr: string) => `xpath=${expr}`,
      cssSelector: (expr: string) => `css=${expr}`,
      id: (id: string) => `#${id}`,
      name: (name: string) => `[name="${name}"]`,
      className: (cls: string) => `.${cls}`,
      tagName: (tag: string) => tag,
    });

    // WebUiCommonHelper
    this.globalScope.declare('WebUiCommonHelper', {
      findWebElement: async (testObj: any, timeout: number) => {
        const selector = testObj instanceof TestObjectWrapper ? testObj.getSelector() : String(testObj);
        // Find the real element via Playwright
        const handle = await this.executor.findElement(selector, (timeout || 10) * 1000);
        if (!handle) throw new Error(`Element not found: ${selector}`);
        return this.createElementHandleProxy(handle);
      },
    });

    // DriverFactory
    this.globalScope.declare('DriverFactory', {
      getWebDriver: () => {
        return this.createDriverProxy();
      },
      changeWebDriver: (_driver: any) => {
        // 우리 앱에서는 드라이버 교체 불필요 (Appium이 직접 처리)
        // 호환성을 위해 에러 없이 무시
      },
    });

    // LogType enum
    this.globalScope.declare('LogType', {
      BROWSER: 'browser',
      DRIVER: 'driver',
      PERFORMANCE: 'performance',
    });

    // Random is handled by new Random() in evalNew
    // But also register as a class reference
    this.globalScope.declare('Random', function() {
      return {
        nextInt: (bound?: number) => bound ? Math.floor(Math.random() * bound) : Math.floor(Math.random() * 2147483647),
      };
    });

    // ─── 표준 Katalon Import 별칭 (예시 스크립트 26개 import 기반) ───

    // Java 시간 API → JavaScript Date 래핑
    this.globalScope.declare('LocalDateTime', {
      now: () => {
        const d = new Date();
        return {
          getYear: () => d.getFullYear(),
          getMonthValue: () => d.getMonth() + 1,
          getDayOfMonth: () => d.getDate(),
          getHour: () => d.getHours(),
          getMinute: () => d.getMinutes(),
          getSecond: () => d.getSeconds(),
          getDayOfWeek: () => ({
            getDisplayName: (_style: any, _locale: any) => {
              const days = ['일', '월', '화', '수', '목', '금', '토'];
              return days[d.getDay()];
            },
            getValue: () => d.getDay() === 0 ? 7 : d.getDay(),
          }),
          format: (formatter: any) => {
            if (typeof formatter === 'function') return formatter(d);
            return d.toISOString();
          },
          toString: () => d.toISOString(),
        };
      },
    });

    // LocalDate (java.time.LocalDate) → 날짜만
    this.globalScope.declare('LocalDate', {
      now: () => {
        const d = new Date();
        return {
          getYear: () => d.getFullYear(),
          getMonthValue: () => d.getMonth() + 1,
          getDayOfMonth: () => d.getDate(),
          getDayOfWeek: () => ({
            getDisplayName: (_style: any, _locale: any) => {
              const days = ['일', '월', '화', '수', '목', '금', '토'];
              return days[d.getDay()];
            },
            getValue: () => d.getDay() === 0 ? 7 : d.getDay(),
          }),
          toString: () => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        };
      },
    });

    this.globalScope.declare('DateTimeFormatter', {
      ofPattern: (pattern: string) => {
        return (d: Date) => {
          return pattern
            .replace('yyyy', String(d.getFullYear()))
            .replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
            .replace('dd', String(d.getDate()).padStart(2, '0'))
            .replace('HH', String(d.getHours()).padStart(2, '0'))
            .replace('mm', String(d.getMinutes()).padStart(2, '0'))
            .replace('ss', String(d.getSeconds()).padStart(2, '0'));
        };
      },
    });

    this.globalScope.declare('TextStyle', {
      SHORT: 'SHORT',
      FULL: 'FULL',
      NARROW: 'NARROW',
    });

    this.globalScope.declare('Locale', {
      KOREAN: 'ko',
      ENGLISH: 'en',
    });

    // Selenium WebElement (Appium WebView 모드에서 사용)
    this.globalScope.declare('WebElement', {});

    // MobileDriverFactory → driver proxy 반환
    this.globalScope.declare('MobileDriverFactory', {
      getDriver: () => this.createDriverProxy(),
      getWebDriver: () => this.createDriverProxy(),
    });

    // AppiumDriver는 driver proxy와 동일
    this.globalScope.declare('AppiumDriver', {});

    // CustomKeywords support for mobile
    // Usage: CustomKeywords."mobile.CoordinateMapProvider.getMap"()
    // Usage: CustomKeywords."mobile.ActionHelper.getCurrentAppIdentifier"()
    const appiumExec = this.appiumExecutor;
    this.globalScope.declare('CustomKeywords', new Proxy({}, {
      get(_target: any, prop: string) {
        // prop will be like "mobile.CoordinateMapProvider.getMap"
        return async (...args: any[]) => {
          if (prop.includes('CoordinateMapProvider.getMap')) {
            // Return a coordinate map proxy that supports coordinateMap["key"].tap()
            return new Proxy({}, {
              get(_t: any, key: string) {
                return {
                  tap: async () => {
                    // Coordinate-based tap - user must define coordinates
                    // For now, log a warning
                    console.log(`CustomKeywords coordinate tap: ${key}`);
                  },
                };
              },
            });
          }
          if (prop.includes('ActionHelper.getCurrentAppIdentifier')) {
            // Return current app package from appium
            if (appiumExec) {
              try {
                return (appiumExec as any).config?.appPackage || '';
              } catch {
                return '';
              }
            }
            return '';
          }
          // Unknown custom keyword - log and return null
          console.log(`Unknown CustomKeyword: ${prop}(${args.join(', ')})`);
          return null;
        };
      },
    }));
  }

  /**
   * Wrap a real Playwright ElementHandle so Groovy scripts can call
   * getText(), click(), isDisplayed(), isEnabled(), findElements(), etc.
   */
  private createElementHandleProxy(handle: any): any {
    const self = this;
    return {
      _handle: handle,
      getText: async () => {
        const text = await handle.textContent();
        return text ?? '';
      },
      click: async () => {
        await handle.click();
      },
      isDisplayed: async () => {
        try { return await handle.isVisible(); } catch { return false; }
      },
      isEnabled: async () => {
        try { return await handle.isEnabled(); } catch { return false; }
      },
      findElements: async (bySelector: string) => {
        const resolvedSel = self.executor.resolveSelector(bySelector);
        const elements = await handle.$$(resolvedSel);
        return elements.map((el: any) => self.createElementHandleProxy(el));
      },
      findElement: async (bySelector: string) => {
        const resolvedSel = self.executor.resolveSelector(bySelector);
        const el = await handle.$(resolvedSel);
        return el ? self.createElementHandleProxy(el) : null;
      },
    };
  }

  private createDriverProxy(): any {
    const appiumExec = this.appiumExecutor;
    return {
      manage: () => ({
        logs: () => ({
          get: (logType: string) => {
            // Return empty log entries - browser console logs
            return [];
          },
        }),
      }),
      // WebView context switching: driver.context("WEBVIEW_xxx") or driver.context("WEBVIEW")
      context: async (contextName: string) => {
        if (appiumExec) {
          let target = contextName;
          if (target === 'WEBVIEW' || target === 'WEBVIEW_') {
            const contexts = await (appiumExec as any).appiumService.getContexts();
            // fullContextList 시 객체 배열 대응
            for (const c of contexts) {
              const id = typeof c === 'string' ? c : (c?.id || c?.context || '');
              if (typeof id === 'string' && id.startsWith('WEBVIEW_')) { target = id; break; }
            }
          }
          await (appiumExec as any).appiumService.setContext(target);
        }
      },
      // Get available contexts
      getContextHandles: async () => {
        if (appiumExec) {
          return await (appiumExec as any).appiumService.getContexts();
        }
        return ['NATIVE_APP'];
      },
      // Selenium-compatible findElement for WebView mode
      findElement: async (bySelector: string) => {
        if (appiumExec) {
          const strategy = bySelector.startsWith('xpath=') ? 'xpath' : 'css selector';
          const value = bySelector.replace(/^xpath=/, '');
          const elementId = await (appiumExec as any).appiumService.findElement(strategy, value);
          return {
            click: async () => await (appiumExec as any).appiumService.clickElement(elementId),
            getText: async () => await (appiumExec as any).appiumService.getElementText(elementId),
            sendKeys: async (text: string) => await (appiumExec as any).appiumService.setElementValue(elementId, text),
          };
        }
        // Fallback to Playwright for web
        const handle = await this.executor.findElement(bySelector, 10000);
        return this.createElementHandleProxy(handle);
      },
    };
  }

  // ─── Utility ───

  private isTruthy(value: any): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }
}
