import * as fs from 'fs';
import * as path from 'path';
import type { MobileConfig, AppiumCommand } from '../../shared/types/mobile';
import type { StepCallback } from './executor';
import { AppiumService, AppiumError } from '../services/appiumService';
import { mapMobileCommand } from './appiumCommandMapper';

export class AppiumExecutor {
  private sessionId: string | null = null;
  private aborted = false;
  private projectPath: string = '';

  constructor(
    private appiumService: AppiumService,
    private config: MobileConfig,
  ) {}

  // ─── Session Lifecycle ───

  async ensureSession(): Promise<void> {
    if (this.sessionId) {
      const alive = await this.appiumService.isSessionAlive();
      if (alive) return;
      this.sessionId = null;
    }

    // 시작 전 기존 세션 정리
    await this.appiumService.cleanupAllSessions();
    this.currentContext = 'NATIVE_APP';
    this.userExplicitContext = false;

    const isIos = this.config.platform === 'ios';

    // 기기 미선택 시 자동 감지
    if (!this.config.deviceUdid) {
      const device = await this.autoDetectDevice(isIos);
      if (!device) {
        throw new Error(isIos
          ? '연결된 iOS 기기를 찾을 수 없습니다. USB 케이블과 "이 컴퓨터를 신뢰" 설정을 확인해주세요.'
          : '연결된 Android 기기를 찾을 수 없습니다. USB 케이블과 USB 디버깅을 확인해주세요.');
      }
      this.config = { ...this.config, deviceUdid: device.udid, deviceName: device.name };
    }

    // iOS는 bundleId, Android는 appPackage 필요
    const appId = isIos ? (this.config.bundleId || this.config.appPackage) : this.config.appPackage;
    if (!appId) {
      throw new Error(isIos
        ? 'Bundle ID가 설정되지 않았습니다. Settings에서 입력해주세요.'
        : 'App Package가 설정되지 않았습니다. Settings에서 입력해주세요.');
    }
    // bundleId가 별도로 없으면 appPackage를 사용
    if (isIos && !this.config.bundleId) {
      this.config = { ...this.config, bundleId: this.config.appPackage };
    }

    await this.appiumService.ensureServerRunning(this.config.platform || 'android');
    await this.appiumService.cleanupAllSessions();
    this.sessionId = await this.appiumService.createSession(this.config);
  }

  private async autoDetectDevice(isIos: boolean = false): Promise<{ udid: string; name: string } | null> {
    try {
      const { execSync } = require('child_process');

      if (isIos) {
        // iOS: idevice_id → xcrun devicectl 순서
        try {
          const output = execSync('idevice_id -l', { stdio: 'pipe', timeout: 5000 }).toString().trim();
          if (output) {
            const udid = output.split('\n')[0].trim();
            const name = execSync(`ideviceinfo -u ${udid} -k DeviceName`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
            return { udid, name: name || udid };
          }
        } catch {}
        // fallback: xcrun devicectl
        try {
          const tmpPath = `/tmp/autodetect_${Date.now()}.json`;
          execSync(`xcrun devicectl list devices --json-output ${tmpPath}`, { stdio: 'pipe', timeout: 10000 });
          const content = require('fs').readFileSync(tmpPath, 'utf-8');
          require('fs').unlinkSync(tmpPath);
          const json = JSON.parse(content);
          for (const device of (json.result?.devices || [])) {
            if (device.connectionProperties?.transportType === 'wired' && device.hardwareProperties?.udid) {
              return {
                udid: device.hardwareProperties.udid,
                name: device.deviceProperties?.name || device.hardwareProperties.udid,
              };
            }
          }
        } catch {}
        return null;
      }

      // Android: adb devices
      const output = execSync('adb devices', { stdio: 'pipe', timeout: 5000 }).toString();
      const lines = output.split('\n').filter((l: string) => l.includes('\tdevice'));
      if (lines.length === 0) return null;
      const udid = lines[0].split('\t')[0];
      const name = execSync(`adb -s ${udid} shell getprop ro.product.model`, { stdio: 'pipe', timeout: 3000 }).toString().trim();
      return { udid, name: name || udid };
    } catch {
      return null;
    }
  }

  async closeSession(): Promise<void> {
    if (this.sessionId) {
      await this.appiumService.deleteSession();
      this.sessionId = null;
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
    this.appiumService.abort();
    await this.closeSession();
  }

  setProjectPath(projectPath: string): void {
    this.projectPath = projectPath;
  }

  // ─── Command Execution ───

  async runMobileCommand(
    method: string,
    args: any[],
    lineNumber: number,
    onStep: StepCallback,
  ): Promise<any> {
    if (this.aborted) throw new Error('Execution aborted');

    const cmd = mapMobileCommand(method, args, lineNumber);
    const label = `Mobile.${method}(${this.formatArgs(args)})`;

    // Session recovery: check before commands that need an active session
    if (cmd.action !== 'startApp' && cmd.action !== 'closeApp' && cmd.action !== 'delay' && cmd.action !== 'comment') {
      if (this.sessionId && !(await this.appiumService.isSessionAlive())) {
        // Session died mid-execution, attempt recovery
        this.sessionId = null;
        await this.ensureSession();
      }
    }

    switch (cmd.action) {
      case 'startApp':
        return this.handleStartApp(cmd);

      case 'closeApp': {
        const closeAppId = this.config.platform === 'ios'
          ? (this.config.bundleId || this.config.appPackage)
          : this.config.appPackage;
        if (closeAppId) {
          await this.appiumService.terminateApp(closeAppId, this.config.platform || 'android');
        }
        return this.closeSession();
      }

      case 'tap':
        return this.handleTap(cmd);

      case 'tapCoord':
        return this.appiumService.tap(cmd.extra!.x, cmd.extra!.y);

      case 'setText':
        return this.handleSetText(cmd);

      case 'verifyExist':
        return this.handleVerifyExist(cmd);

      case 'verifyVisible':
        return this.handleVerifyVisible(cmd);

      case 'verifyNotExist':
        return this.handleVerifyNotExist(cmd);

      case 'verifyText':
        return this.handleVerifyText(cmd);

      case 'scrollToText':
        return this.appiumService.scrollToText(cmd.value!);

      case 'swipe':
        return this.appiumService.swipe(
          cmd.extra!.startX, cmd.extra!.startY,
          cmd.extra!.endX, cmd.extra!.endY,
        );

      case 'delay':
        return this.interruptibleDelay(cmd.timeout ?? 1000);

      case 'comment':
        // Log only, no device action
        return;

      case 'getAttribute':
        return this.handleGetAttribute(cmd);

      case 'getDeviceHeight': {
        const rect = await this.appiumService.getWindowRect();
        return rect.height;
      }

      case 'getDeviceWidth': {
        const rect = await this.appiumService.getWindowRect();
        return rect.width;
      }

      case 'toggleAirplaneMode':
        return this.appiumService.toggleAirplaneMode();

      case 'takeScreenshot':
        return this.appiumService.takeScreenshot();

      case 'hideKeyboard':
        return this.appiumService.hideKeyboard();

      case 'getPageSource':
        return this.appiumService.getPageSource();

      case 'getText':
        return this.handleGetText(cmd);

      case 'getContexts':
        return this.appiumService.getContexts();

      case 'setContext': {
        let targetContext = cmd.value!;

        // NATIVE_APP 전환은 바로 실행
        if (targetContext === 'NATIVE_APP') {
          await this.appiumService.setContext('NATIVE_APP');
          this.currentContext = 'NATIVE_APP';
          this.userExplicitContext = false;
          return;
        }

        const isAutoDetect = targetContext === 'WEBVIEW' || targetContext === 'WEBVIEW_';

        // 최대 30초 대기: 컨텍스트 찾기 + 전환까지 성공할 때까지 재시도
        const MAX_WAIT = 30;
        for (let i = 0; i < MAX_WAIT; i++) {
          if (this.aborted) throw new Error('Execution aborted');
          try {
            if (isAutoDetect) {
              const contexts = await this.appiumService.getContexts();
              const found = this.findWebviewContext(contexts);
              if (!found) {
                if (i < MAX_WAIT - 1) { await this.interruptibleDelay(1000); continue; }
                throw new Error('WebView 컨텍스트를 찾을 수 없습니다 (30초 대기).');
              }
              targetContext = found;
            }
            await this.appiumService.setContext(targetContext);
            this.currentContext = targetContext;
            this.userExplicitContext = true;
            return;
          } catch (err: any) {
            if (this.aborted) throw new Error('Execution aborted');
            if (i >= MAX_WAIT - 1) throw err;
            await this.interruptibleDelay(1000);
          }
        }
        return;
      }

      case 'unknown':
        throw new Error(cmd.value || `Unknown command: ${method}`);

      default:
        throw new Error(`Unsupported mobile action: ${cmd.action}`);
    }
  }

  // ─── Command Handlers ───

  private async handleStartApp(cmd: AppiumCommand): Promise<void> {
    // 스크립트에서 앱 패키지를 지정한 경우 config 업데이트
    if (cmd.value) {
      if (this.config.platform === 'ios') {
        this.config = { ...this.config, bundleId: cmd.value, appPackage: cmd.value };
      } else {
        this.config = { ...this.config, appPackage: cmd.value };
      }
    }
    // 세션 생성 (앱 없이 기기만 연결)
    await this.ensureSession();
    // 앱 강제 재시작 (이전 WebView 소켓 정리)
    const appId = this.config.platform === 'ios'
      ? (this.config.bundleId || this.config.appPackage)
      : this.config.appPackage;
    if (appId) {
      const platform = this.config.platform || 'android';
      await this.appiumService.terminateApp(appId, platform);
      await this.interruptibleDelay(1000);
      if (this.aborted) return;
      await this.appiumService.activateApp(appId, platform);
    }
  }

  private async handleTap(cmd: AppiumCommand): Promise<void> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    const elementId = await this.appiumService.findElement(strategy, value, cmd.timeout);
    try {
      await this.appiumService.clickElement(elementId);
    } catch (err: any) {
      // ELEMENT_NOT_INTERACTABLE → 좌표 기반 탭으로 fallback
      if (err?.message?.includes('ELEMENT_NOT_INTERACTABLE') || err?.code === 'ELEMENT_NOT_INTERACTABLE') {
        const rect = await this.appiumService.getElementRect(elementId);
        const cx = Math.round(rect.x + rect.width / 2);
        const cy = Math.round(rect.y + rect.height / 2);
        await this.appiumService.tap(cx, cy);
      } else {
        throw err;
      }
    }
  }

  private async handleSetText(cmd: AppiumCommand): Promise<void> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    const elementId = await this.appiumService.findElement(strategy, value, cmd.timeout);
    await this.appiumService.setElementValue(elementId, cmd.value ?? '');
    await this.appiumService.hideKeyboard();
  }

  private async handleVerifyExist(cmd: AppiumCommand): Promise<void> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    await this.appiumService.findElement(strategy, value, cmd.timeout);
  }

  private async handleGetText(cmd: AppiumCommand): Promise<string> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    const elementId = await this.appiumService.findElement(strategy, value, cmd.timeout);
    return this.appiumService.getElementText(elementId);
  }

  private async handleVerifyVisible(cmd: AppiumCommand): Promise<void> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    const elementId = await this.appiumService.findElement(strategy, value, cmd.timeout);
    const visible = await this.appiumService.isElementDisplayed(elementId);
    if (!visible) {
      throw new Error(`Element not visible: ${cmd.selector}`);
    }
  }

  private async handleVerifyNotExist(cmd: AppiumCommand): Promise<void> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    try {
      await this.appiumService.findElement(strategy, value, Math.min(cmd.timeout ?? 3000, 3000));
      throw new Error(`Element should not exist but was found: ${cmd.selector}`);
    } catch (err: any) {
      if (err instanceof AppiumError && err.code === 'ELEMENT_NOT_FOUND') {
        return; // Expected: element not found = verification passed
      }
      if (err.message?.includes('should not exist')) throw err;
      return; // Element not found by other means = pass
    }
  }

  private async handleVerifyText(cmd: AppiumCommand): Promise<void> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    const elementId = await this.appiumService.findElement(strategy, value, cmd.timeout);
    const text = await this.appiumService.getElementText(elementId);
    if (text.trim() !== (cmd.value ?? '').trim()) {
      throw new Error(`Text mismatch: expected "${cmd.value}", got "${text.trim()}"`);
    }
  }

  private async handleGetAttribute(cmd: AppiumCommand): Promise<string> {
    await this.autoSwitchContextIfNeeded(cmd.selector!);
    const { strategy, value } = this.resolveTestObject(cmd.selector!);
    const elementId = await this.appiumService.findElement(strategy, value, cmd.timeout);
    return this.appiumService.getElementAttribute(elementId, cmd.value ?? '');
  }

  // ─── Context Helpers ───

  /** getContexts 결과에서 WEBVIEW_ 컨텍스트 ID 찾기 (문자열 또는 객체 배열 대응) */
  private findWebviewContext(contexts: any[]): string | undefined {
    for (const c of contexts) {
      const id = typeof c === 'string' ? c : (c?.id || c?.context || '');
      if (typeof id === 'string' && id.startsWith('WEBVIEW_')) return id;
    }
    return undefined;
  }

  // ─── Auto WebView Context Switching ───

  private currentContext: string = 'NATIVE_APP';
  private userExplicitContext: boolean = false; // 사용자가 명시적으로 컨텍스트 설정했는지

  private async autoSwitchContextIfNeeded(selector: string): Promise<void> {
    // 사용자가 switchToContext로 명시적 설정했으면 자동 전환 안 함
    if (this.userExplicitContext) return;

    // HTML XPath (/html/body/...) 또는 CSS 웹 셀렉터면 WebView로 전환
    const isWebSelector = selector.includes('/html') || selector.includes('/body')
      || selector.includes('div[') || selector.includes('button[')
      || selector.includes('span[') || selector.includes('span>')
      || selector.includes('.today-badge') || selector.includes('#');

    if (isWebSelector && this.currentContext === 'NATIVE_APP') {
      // WebView context 자동 탐지 및 전환 (iOS는 준비 시간 필요 → 재시도)
      const MAX_RETRIES = 3;
      for (let i = 0; i < MAX_RETRIES; i++) {
        if (this.aborted) return;
        try {
          const contexts = await this.appiumService.getContexts();
          const webviewContext = this.findWebviewContext(contexts);
          if (webviewContext) {
            await this.appiumService.setContext(webviewContext);
            this.currentContext = webviewContext;
            return;
          }
          if (i < MAX_RETRIES - 1) {
            await this.interruptibleDelay(2000);
          }
        } catch {
          if (i < MAX_RETRIES - 1) {
            await this.interruptibleDelay(2000);
          }
        }
      }
      // 재시도 다 실패하면 NATIVE에서 그대로 진행 (엘리먼트 검색은 시도)
    } else if (!isWebSelector && this.currentContext !== 'NATIVE_APP') {
      // 네이티브 셀렉터면 다시 NATIVE로
      try {
        await this.appiumService.setContext('NATIVE_APP');
      } catch {
        // 이미 NATIVE이거나 컨텍스트 에러 → 무시
      }
      this.currentContext = 'NATIVE_APP';
    }
  }

  // ─── TestObject Resolution (3-stage fallback) ───

  resolveTestObject(testObjectPath: string): { strategy: string; value: string } {
    // 1. xpath= 직접 표기 or / 시작
    if (testObjectPath.startsWith('xpath=')) {
      return { strategy: 'xpath', value: testObjectPath.substring(6) };
    }
    if (testObjectPath.startsWith('/') || testObjectPath.startsWith('(')) {
      return { strategy: 'xpath', value: testObjectPath };
    }

    // 2. Object Repository .rs 파일 파싱
    if (this.projectPath) {
      const rsResult = this.tryResolveFromObjectRepository(testObjectPath);
      if (rsResult) return rsResult;
    }

    // 3. 휴리스틱 폴백
    const lastSegment = testObjectPath.split(/[\/\\]/).pop() || testObjectPath;
    // Object Repository 경로에서 의미 있는 부분 추출
    const cleanName = lastSegment
      .replace(/^(button|input|linktext|text|label|icon)-?/i, '')
      .replace(/\s*-\s*/g, ' ')
      .trim();

    if (cleanName) {
      return {
        strategy: 'xpath',
        value: `//*[contains(@resource-id,'${lastSegment}') or contains(@text,'${cleanName}') or contains(@content-desc,'${cleanName}')]`,
      };
    }

    return { strategy: 'xpath', value: `//*[contains(@resource-id,'${lastSegment}')]` };
  }

  private tryResolveFromObjectRepository(testObjectPath: string): { strategy: string; value: string } | null {
    // Remove 'Object Repository/' prefix if present
    const cleanPath = testObjectPath.replace(/^Object Repository[\/\\]/, '');
    const rsFilePath = path.join(this.projectPath, 'Object Repository', `${cleanPath}.rs`);

    try {
      if (!fs.existsSync(rsFilePath)) return null;

      const content = fs.readFileSync(rsFilePath, 'utf-8');

      // Parse XML-like .rs file for selector
      // Look for BASIC or XPATH selector
      const basicMatch = content.match(/<key>BASIC<\/key>\s*<value>(.*?)<\/value>/s);
      if (basicMatch) {
        return { strategy: 'xpath', value: basicMatch[1].trim() };
      }

      const xpathMatch = content.match(/<key>XPATH<\/key>\s*<value>(.*?)<\/value>/s);
      if (xpathMatch) {
        return { strategy: 'xpath', value: xpathMatch[1].trim() };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ─── Utilities ───

  /** 중단 가능한 대기 — 500ms 단위로 aborted 체크 */
  private interruptibleDelay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const interval = 500;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += interval;
        if (this.aborted) {
          clearInterval(timer);
          reject(new Error('Execution aborted'));
        } else if (elapsed >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, interval);
    });
  }

  private formatArgs(args: any[]): string {
    return args.map(a => {
      if (typeof a === 'string') {
        const short = a.length > 30 ? a.substring(0, 30) + '...' : a;
        return `"${short}"`;
      }
      return String(a);
    }).join(', ');
  }
}
