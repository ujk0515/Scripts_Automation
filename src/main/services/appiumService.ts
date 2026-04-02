import * as fs from 'fs';
import { spawn, execSync, type ChildProcess } from 'child_process';
import type { MobileConfig } from '../../shared/types/mobile';

// ─── Appium Error Handling ───

const APPIUM_ERROR_MAP: Record<string, string> = {
  'no such element': 'ELEMENT_NOT_FOUND',
  'stale element reference': 'ELEMENT_NOT_FOUND',
  'element not interactable': 'ELEMENT_NOT_INTERACTABLE',
  'invalid element state': 'ELEMENT_NOT_INTERACTABLE',
  'no such session': 'SESSION_TIMEOUT',
  'session not created': 'SESSION_CREATE_FAILED',
  'unknown error': 'APPIUM_UNKNOWN_ERROR',
  'timeout': 'COMMAND_TIMEOUT',
  'invalid argument': 'INVALID_ARGUMENT',
  'no such context': 'CONTEXT_NOT_FOUND',
};

// ─── Error Guidance (Mopath 참고: appium_service.dart:714-762) ───

const ERROR_GUIDANCE: Record<string, string> = {
  'ANDROID_HOME': 'Android SDK를 찾을 수 없습니다. Android Studio를 설치해주세요.',
  'not trusted': '디바이스가 이 컴퓨터를 신뢰하지 않습니다. 기기에서 "허용"을 눌러주세요.',
  'could not be located': '엘리먼트를 찾을 수 없습니다. 셀렉터를 확인해주세요.',
  'ECONNREFUSED': 'Appium 서버에 연결할 수 없습니다.',
  'Original error: Could not proxy': 'UiAutomator2 연결이 끊어졌습니다. 세션을 재생성합니다.',
  'cannot be blank': '기기 UDID 또는 앱 패키지가 비어있습니다. 설정을 확인해주세요.',
  'not installed': '앱이 기기에 설치되어 있지 않습니다.',
  'xcodebuild failed': 'Xcode 빌드 실패. Xcode 설정과 프로비저닝을 확인해주세요.',
  'WebDriverAgent': 'WebDriverAgent 설치/실행 실패. Xcode에서 WDA 프로젝트를 수동 빌드해보세요.',
  'Unable to launch WebDriverAgent': 'WDA 실행 불가. 기기에서 "개발자 앱 신뢰" 설정을 확인해주세요.',
  'Could not determine iOS SDK version': 'iOS SDK를 찾을 수 없습니다. Xcode가 올바르게 설치되었는지 확인해주세요.',
};

export class AppiumError extends Error {
  constructor(
    public code: string,
    message: string,
    public appiumError?: string,
  ) {
    super(message);
    this.name = 'AppiumError';
  }

  /** 사용자 친화적 에러 메시지 반환 (Mopath 참고) */
  getUserMessage(): string {
    const msg = this.message.toLowerCase();
    for (const [keyword, guidance] of Object.entries(ERROR_GUIDANCE)) {
      if (msg.includes(keyword.toLowerCase())) return guidance;
    }
    return this.message;
  }
}

// ─── Environment Resolver (Mopath 참고: appium_service.dart:272-456) ───

let cachedEnv: NodeJS.ProcessEnv | null = null;

function getEnrichedEnv(): NodeJS.ProcessEnv {
  if (cachedEnv) return cachedEnv;

  const isWin = process.platform === 'win32';
  const pathSep = isWin ? ';' : ':';
  const env = { ...process.env };
  // Windows: 환경변수 키가 'Path'일 수 있음 (대소문자 구분)
  const pathKey = isWin
    ? (Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'Path')
    : 'PATH';
  const pathParts = new Set<string>((env[pathKey] || '').split(pathSep));

  if (isWin) {
    // ─── Windows ───
    const userProfile = process.env.USERPROFILE || '';
    const appData = process.env.APPDATA || '';

    // 1. npm global (appium 설치 경로)
    if (appData) {
      pathParts.add(`${appData}\\npm`);
    }

    // 2. nvm-windows, volta, fnm
    if (userProfile) {
      [`${userProfile}\\.nvm`, `${userProfile}\\.volta\\bin`, `${userProfile}\\AppData\\Local\\fnm_multishells`]
        .forEach(p => { if (fs.existsSync(p)) pathParts.add(p); });
    }

    // 3. Android SDK
    if (!env.ANDROID_HOME) {
      const candidates = [
        `${process.env.LOCALAPPDATA || ''}\\Android\\Sdk`,
        `${userProfile}\\AppData\\Local\\Android\\Sdk`,
        `${userProfile}\\Android\\Sdk`,
      ];
      for (const c of candidates) {
        if (c && fs.existsSync(c)) {
          env.ANDROID_HOME = c;
          env.ANDROID_SDK_ROOT = c;
          pathParts.add(`${c}\\platform-tools`);
          break;
        }
      }
    } else {
      pathParts.add(`${env.ANDROID_HOME}\\platform-tools`);
    }

    // 4. Java
    if (!env.JAVA_HOME) {
      const javaBase = `${process.env.ProgramFiles || 'C:\\Program Files'}\\Java`;
      try {
        if (fs.existsSync(javaBase)) {
          const dirs = fs.readdirSync(javaBase).filter(d => d.startsWith('jdk'));
          if (dirs.length > 0) {
            env.JAVA_HOME = `${javaBase}\\${dirs[dirs.length - 1]}`;
          }
        }
      } catch {}
    }
  } else {
    // ─── macOS / Linux ───

    // 1. 로그인 쉘 PATH (nvm, volta 등 포함)
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const result = execSync(`${shell} -lc 'echo $PATH'`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      result.split(':').forEach(p => pathParts.add(p));
    } catch {}

    // 2. macOS Homebrew
    if (process.platform === 'darwin') {
      ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'].forEach(p => pathParts.add(p));
    }

    // 3. Android SDK
    if (!env.ANDROID_HOME) {
      const home = process.env.HOME || '';
      const candidates = [
        `${home}/Library/Android/sdk`,
        `${home}/Android/Sdk`,
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          env.ANDROID_HOME = c;
          env.ANDROID_SDK_ROOT = c;
          pathParts.add(`${c}/platform-tools`);
          break;
        }
      }
    } else {
      pathParts.add(`${env.ANDROID_HOME}/platform-tools`);
    }

    // 4. Java (macOS)
    if (process.platform === 'darwin' && !env.JAVA_HOME) {
      try {
        const javaHome = execSync('/usr/libexec/java_home', { stdio: 'pipe', timeout: 3000 }).toString().trim();
        if (javaHome) env.JAVA_HOME = javaHome;
      } catch {}
    }
  }

  env[pathKey] = Array.from(pathParts).filter(Boolean).join(pathSep);
  cachedEnv = env;
  return env;
}

// ─── AppiumService ───

export class AppiumService {
  private port: number;
  private serverProcess: ChildProcess | null = null;
  private sessionId: string | null = null;
  private currentAbortController: AbortController | null = null;
  private driverCache: Record<string, boolean> = {};
  private driverCacheTime: number = 0;

  constructor(port: number = 4723) {
    this.port = port;
  }

  // ─── Server Management ───

  async isInstalled(): Promise<boolean> {
    try {
      execSync('appium --version', { stdio: 'pipe', env: getEnrichedEnv() });
      return true;
    } catch {
      return false;
    }
  }

  async isServerRunning(): Promise<boolean> {
    try {
      const res = await this.rawFetch('GET', '/status');
      return res.ok;
    } catch {
      return false;
    }
  }

  async startServer(): Promise<void> {
    if (await this.isServerRunning()) return;

    return new Promise((resolve, reject) => {
      const proc = spawn('appium', [
        '--port', String(this.port),
        '--address', '127.0.0.1',
        '--log-level', 'error',
        '--allow-insecure=uiautomator2:chromedriver_autodownload',
        '--allow-insecure=xcuitest:get_server_logs',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        shell: true,
        env: getEnrichedEnv(),
      });

      this.serverProcess = proc;
      let stderrOutput = '';

      proc.stderr?.on('data', (data) => {
        stderrOutput += data.toString();
      });

      const timeout = setTimeout(() => {
        reject(new AppiumError('APPIUM_START_FAILED', 'Appium server start timed out'));
      }, 30000);

      const checkReady = setInterval(async () => {
        if (await this.isServerRunning()) {
          clearInterval(checkReady);
          clearTimeout(timeout);
          resolve();
        }
      }, 1000);

      proc.on('error', (err) => {
        clearInterval(checkReady);
        clearTimeout(timeout);
        reject(new AppiumError('APPIUM_START_FAILED', `Failed to start Appium: ${err.message}`));
      });

      proc.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearInterval(checkReady);
          clearTimeout(timeout);
          const detail = stderrOutput.trim().slice(-200);
          reject(new AppiumError('APPIUM_START_FAILED', `Appium exited with code ${code}${detail ? ': ' + detail : ''}`));
        }
      });
    });
  }

  async stopServer(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }

  async ensureServerRunning(platform: 'android' | 'ios' = 'android'): Promise<void> {
    if (await this.isServerRunning()) return;

    const installed = await this.isInstalled();
    if (!installed) {
      throw new AppiumError('APPIUM_NOT_INSTALLED', 'Appium이 설치되어 있지 않습니다. "npm install -g appium"으로 설치해주세요.');
    }

    await this.ensureDriverInstalled(platform);
    await this.startServer();
  }

  async ensureDriverInstalled(platform: 'android' | 'ios' = 'android'): Promise<void> {
    const driverName = platform === 'ios' ? 'xcuitest' : 'uiautomator2';

    // 캐시에서 이미 설치 확인됐으면 스킵
    if (this.driverCache[driverName]) return;

    // 캐시 없으면 한번 조회
    const drivers = this.getInstalledDrivers(true);
    if (drivers[driverName]) return;

    // 진짜 없을 때만 설치
    try {
      execSync(`appium driver install ${driverName}`, { stdio: 'pipe', timeout: 300000, env: getEnrichedEnv() });
      this.driverCache[driverName] = true;
      this.driverCacheTime = Date.now();
    } catch {
      // 이미 설치돼있는데 install이 에러나는 경우 → 다시 확인
      const recheck = this.getInstalledDrivers(true);
      if (recheck[driverName]) return;
      // 진짜 실패면 세션 생성 시 에러남
    }
  }

  /** 설치된 Appium 드라이버 목록 반환 (캐시 30초) */
  getInstalledDrivers(forceRefresh: boolean = false): Record<string, boolean> {
    const CACHE_TTL = 30_000;
    if (!forceRefresh && this.driverCacheTime > 0 && (Date.now() - this.driverCacheTime) < CACHE_TTL) {
      return { ...this.driverCache };
    }

    try {
      const output = execSync('appium driver list --installed --json', {
        stdio: 'pipe', timeout: 10000, env: getEnrichedEnv(),
      }).toString();
      const drivers = JSON.parse(output);
      this.driverCache = {
        uiautomator2: !!drivers.uiautomator2,
        xcuitest: !!drivers.xcuitest,
      };
      this.driverCacheTime = Date.now();
      return { ...this.driverCache };
    } catch {
      // 파싱 실패해도 기존 캐시가 있으면 유지 (불필요한 재설치 방지)
      if (this.driverCacheTime > 0) {
        return { ...this.driverCache };
      }
      return { uiautomator2: false, xcuitest: false };
    }
  }

  /** 드라이버 캐시 초기화 (수동 리셋 필요 시) */
  clearDriverCache(): void {
    this.driverCache = {};
    this.driverCacheTime = 0;
  }

  // ─── Stale Session Cleanup (Mopath 참고: appium_service.dart:775-804) ───

  async cleanupAllSessions(): Promise<void> {
    // 현재 세션이 있으면 삭제
    if (this.sessionId) {
      try {
        await this.request('DELETE', `/session/${this.sessionId}`);
      } catch {}
      this.sessionId = null;
    }
  }

  // ─── Session Management ───

  async createSession(config: MobileConfig): Promise<string> {
    const isIos = config.platform === 'ios';

    const capabilities: Record<string, any> = isIos
      ? {
          // ─── iOS / XCUITest ───
          platformName: 'iOS',
          'appium:automationName': 'XCUITest',
          'appium:deviceName': config.deviceName,
          'appium:udid': config.deviceUdid,
          'appium:noReset': config.noReset ?? true,
          'appium:newCommandTimeout': 300,
          'appium:wdaStartupRetries': 3,
          'appium:wdaStartupRetryInterval': 20000,
          'appium:usePrebuiltWDA': true,
          // WebView 디버깅 지원
          'appium:webviewConnectTimeout': 30000,
          'appium:webviewConnectRetries': 10,
          'appium:includeSafariInWebviews': true,
          'appium:fullContextList': true,
          'appium:nativeWebTap': true,
          'appium:safariWebInspectorMaxFrameLength': 20000000,
          ...((config.bundleId || config.appPackage) ? { 'appium:additionalWebviewBundleIds': [config.bundleId || config.appPackage] } : {}),
          ...(config.platformVersion ? { 'appium:platformVersion': config.platformVersion } : {}),
        }
      : {
          // ─── Android / UiAutomator2 ───
          platformName: 'Android',
          'appium:automationName': config.automationName || 'UiAutomator2',
          'appium:deviceName': config.deviceName,
          'appium:udid': config.deviceUdid,
          'appium:noReset': config.noReset ?? true,
          'appium:newCommandTimeout': 300,
          'appium:autoGrantPermissions': true,
          'appium:dontStopAppOnReset': true,
          'appium:chromedriverAutodownload': true,
          'appium:chromedriverExecutableDir': require('path').join(require('os').homedir(), '.appium/node_modules/appium-uiautomator2-driver/node_modules/appium-chromedriver/chromedriver/mac'),
        };

    // appPackage/bundleId는 세션 생성 시 넣지 않음 - activateApp으로 별도 실행
    if (config.appActivity) {
      capabilities['appium:appActivity'] = config.appActivity;
    }

    const result = await this.request<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: capabilities },
    });

    this.sessionId = result.sessionId || (result as any).sessionId;
    return this.sessionId!;
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.request('DELETE', `/session/${this.sessionId}`);
    } catch {
      // session already gone
    }
    this.sessionId = null;
  }

  async isSessionAlive(): Promise<boolean> {
    if (!this.sessionId) return false;
    try {
      await this.request('GET', `/session/${this.sessionId}`);
      return true;
    } catch {
      return false;
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  // ─── Element Operations ───

  async findElement(strategy: string, value: string, timeout?: number): Promise<string> {
    const endTime = Date.now() + (timeout || 10000);

    while (Date.now() < endTime) {
      try {
        const result = await this.request<{ ELEMENT: string; [key: string]: any }>(
          'POST',
          `/session/${this.sessionId}/element`,
          { using: strategy, value },
        );
        // W3C returns element ID in different formats
        return result.ELEMENT || result['element-6066-11e4-a52e-4f735466cecf'] || Object.values(result)[0] as string;
      } catch (err: any) {
        if (err instanceof AppiumError && err.code === 'ELEMENT_NOT_FOUND' && Date.now() < endTime) {
          await this.sleep(500);
          continue;
        }
        throw err;
      }
    }

    throw new AppiumError('ELEMENT_NOT_FOUND', `Element not found: ${strategy}=${value} (timeout: ${timeout}ms)`);
  }

  async clickElement(elementId: string): Promise<void> {
    await this.request('POST', `/session/${this.sessionId}/element/${elementId}/click`);
  }

  async getElementRect(elementId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.request('GET', `/session/${this.sessionId}/element/${elementId}/rect`);
  }

  async setElementValue(elementId: string, text: string): Promise<void> {
    await this.request('POST', `/session/${this.sessionId}/element/${elementId}/value`, {
      text,
      value: text.split(''),
    });
  }

  async getElementText(elementId: string): Promise<string> {
    const result = await this.request<string>('GET', `/session/${this.sessionId}/element/${elementId}/text`);
    return result ?? '';
  }

  async isElementDisplayed(elementId: string): Promise<boolean> {
    const result = await this.request<boolean>('GET', `/session/${this.sessionId}/element/${elementId}/displayed`);
    return result === true;
  }

  async getElementAttribute(elementId: string, attr: string): Promise<string> {
    const result = await this.request<string | null>(
      'GET',
      `/session/${this.sessionId}/element/${elementId}/attribute/${attr}`,
    );
    return result ?? '';
  }

  // ─── Actions (W3C) ───

  async tap(x: number, y: number): Promise<void> {
    await this.request('POST', `/session/${this.sessionId}/actions`, {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 100 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
  }

  async swipe(sx: number, sy: number, ex: number, ey: number, duration: number = 800): Promise<void> {
    await this.request('POST', `/session/${this.sessionId}/actions`, {
      actions: [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(sx), y: Math.round(sy) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration, x: Math.round(ex), y: Math.round(ey) },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
  }

  async scrollToText(text: string): Promise<void> {
    // UiAutomator2 방식: -android uiautomator strategy
    const selector = `new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text("${text}"))`;
    await this.request('POST', `/session/${this.sessionId}/element`, {
      using: '-android uiautomator',
      value: selector,
    });
  }

  // ─── Device ───

  async getWindowRect(): Promise<{ width: number; height: number }> {
    const result = await this.request<{ width: number; height: number }>(
      'GET',
      `/session/${this.sessionId}/window/rect`,
    );
    return { width: result.width, height: result.height };
  }

  async toggleAirplaneMode(): Promise<void> {
    await this.request('POST', `/session/${this.sessionId}/appium/device/toggle_airplane_mode`);
  }

  async activateApp(appId: string, platform: 'android' | 'ios' = 'android'): Promise<void> {
    const param = platform === 'ios' ? { bundleId: appId } : { appId };
    await this.request('POST', `/session/${this.sessionId}/appium/device/activate_app`, param);
  }

  async terminateApp(appId: string, platform: 'android' | 'ios' = 'android'): Promise<void> {
    try {
      const param = platform === 'ios' ? { bundleId: appId } : { appId };
      await this.request('POST', `/session/${this.sessionId}/appium/device/terminate_app`, param);
    } catch {}
  }

  async hideKeyboard(): Promise<void> {
    try {
      await this.request('POST', `/session/${this.sessionId}/appium/device/hide_keyboard`);
    } catch {
      // keyboard may not be visible
    }
  }

  async takeScreenshot(): Promise<string> {
    return await this.request<string>('GET', `/session/${this.sessionId}/screenshot`);
  }

  // ─── WebView ───

  async getContexts(): Promise<string[]> {
    return await this.request<string[]>('GET', `/session/${this.sessionId}/contexts`);
  }

  async setContext(name: string): Promise<void> {
    await this.request('POST', `/session/${this.sessionId}/context`, { name });
  }

  async getPageSource(): Promise<string> {
    return await this.request<string>('GET', `/session/${this.sessionId}/source`);
  }

  // ─── Abort ───

  abort(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
  }

  // ─── Internal HTTP ───

  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const controller = new AbortController();
    this.currentAbortController = controller;

    try {
      const url = `http://127.0.0.1:${this.port}${path}`;
      const options: any = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (body) options.body = JSON.stringify(body);

      const response = await fetch(url, options);
      const json = await response.json();

      if (!response.ok || json.value?.error) {
        const appiumError = json.value?.error ?? 'unknown error';
        const message = json.value?.message ?? response.statusText;
        const code = APPIUM_ERROR_MAP[appiumError] ?? 'APPIUM_UNKNOWN_ERROR';
        throw new AppiumError(code, `[${code}] ${message}`, appiumError);
      }

      return json.value as T;
    } finally {
      this.currentAbortController = null;
    }
  }

  private async rawFetch(method: string, path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
