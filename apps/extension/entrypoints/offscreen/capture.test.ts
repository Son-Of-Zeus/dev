import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ listener: undefined as any, send: vi.fn(async () => ({})) }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'extension', getURL: (path: string) => `chrome-extension://extension${path}`, sendMessage: hooks.send, onMessage: { addListener: (listener: any) => { hooks.listener = listener; } } } } }));
class Socket {
  static OPEN = 1; static CONNECTING = 0; static instances: Socket[] = [];
  readyState = 1; bufferedAmount = 0; sent: unknown[] = [];
  onmessage?: (event: {data: string}) => Promise<void>; onclose?: () => void; onerror?: () => void;
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(data: unknown) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  deliver(value: object) { return this.onmessage?.({ data: JSON.stringify(value) }); }
}
let port: { onmessage?: (value: any) => void; postMessage: (value: string) => void };
const stopTrack = vi.fn();
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
const permission = vi.fn(async () => ({ state: 'granted' }));
class Context {
  audioWorklet = { addModule: vi.fn(async () => {}) }; destination = {};
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  resume = vi.fn(async () => {}); close = vi.fn(async () => {});
}
class Worklet {
  port = { onmessage: undefined as any, postMessage(value: string) { if (value === 'flush') this.onmessage?.({ data: 'flushed' }); } };
  constructor() { port = this.port; } connect() {} disconnect() {}
}
function dispatch(op: string, requestId = 'voice-1', provider = 'server') {
  return new Promise<any>((resolve) => hooks.listener({ target: 'offscreen', op, requestId, provider }, { id: 'extension' }, resolve));
}
beforeEach(async () => {
  vi.resetModules(); Socket.instances = []; hooks.send.mockClear(); stopTrack.mockClear(); getUserMedia.mockClear(); permission.mockResolvedValue({state:'granted'});
  Object.defineProperty(navigator, 'permissions', { value: { query: permission }, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet);
  await import('./main');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('offscreen audio transport', () => {
  it('streams PCM and partials, then releases the microphone on final speech', async () => {
    const result = dispatch('capture'); await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0]!; expect(socket.url).toBe('wss://voice-companion-test.modal.run/speech/stream');
    await socket.deliver({type:'ready'}); port.onmessage?.({data:new ArrayBuffer(3840)});
    expect(socket.sent[0]).toBeInstanceOf(ArrayBuffer);
    await socket.deliver({type:'partial',transcript:'Open'}); expect(hooks.send).toHaveBeenCalledWith(expect.objectContaining({transcript:'Open'}));
    await socket.deliver({type:'final',transcript:'Open settings'});
    expect(await result).toEqual({ok:true,data:{transcript:'Open settings'}}); expect(stopTrack).toHaveBeenCalled();
  });
  it('releases the microphone at a local endpoint and waits for the final Hindi transcript', async () => {
    const result = dispatch('capture'); await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0]!; await socket.deliver({type:'ready',provider:'local'});
    await socket.deliver({type:'endpoint'});
    expect(stopTrack).toHaveBeenCalled(); expect(socket.sent).toContain(JSON.stringify({type:'stop'}));
    expect(socket.readyState).toBe(Socket.OPEN);
    await socket.deliver({type:'final',transcript:'सेटिंग खोलें',language:'hi-IN',transcriptionMs:150});
    expect(await result).toEqual({ok:true,data:{transcript:'सेटिंग खोलें',language:'hi-IN',transcriptionMs:150}});
  });
  it('starts the capture limit after the speech service is ready', async () => {
    vi.useFakeTimers();
    try {
      const result = dispatch('capture'); await Promise.resolve(); await Promise.resolve();
      const socket = Socket.instances[0]!;
      await vi.advanceTimersByTimeAsync(29_000);
      await socket.deliver({type:'ready',provider:'local'});
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stopTrack).not.toHaveBeenCalled();
      await socket.deliver({type:'final',transcript:'Ready'}); expect((await result).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('requests visible permission before creating a socket', async () => {
    permission.mockResolvedValue({state:'prompt'});
    expect(await dispatch('capture')).toEqual({ok:false,error:'NEED_MIC_PERMISSION'}); expect(Socket.instances).toHaveLength(0);
  });
  it('surfaces microphone denial and closes the connection', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('denied'));
    const result = dispatch('capture'); await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    await Socket.instances[0]!.deliver({type:'ready'});
    expect(await result).toMatchObject({ok:false,error:expect.stringContaining('microphone')}); expect(Socket.instances[0]!.readyState).toBe(3);
  });
  it('drains PCM on manual stop and still waits for final speech', async () => {
    const result = dispatch('capture'); await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0]!; await socket.deliver({type:'ready'}); await dispatch('stop');
    expect(socket.sent).toContain(JSON.stringify({type:'stop'})); expect(stopTrack).toHaveBeenCalled();
    await socket.deliver({type:'final',transcript:'Done'}); expect((await result).ok).toBe(true);
  });
  it('cleans up cancelled capture and reports an interrupted connection', async () => {
    let result = dispatch('capture'); await vi.waitFor(() => expect(Socket.instances).toHaveLength(1)); await dispatch('cancel'); expect((await result).ok).toBe(false);
    result = dispatch('capture', 'voice-2'); await vi.waitFor(() => expect(Socket.instances).toHaveLength(2)); Socket.instances[1]!.onerror?.(); expect((await result).ok).toBe(false);
  });
});

describe('Chrome recognition transport', () => {
  it('uses browser recognition without creating a backend socket', async () => {
    let recognition: any;
    class Recognition {
      lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
      onresult: any; onend: any; onaudioend: any; onerror: any;
      constructor() { recognition = this; }
      start() {} stop() {} abort() {}
    }
    vi.stubGlobal('webkitSpeechRecognition', Recognition);
    const result = dispatch('capture', 'chrome-turn', 'chrome');
    await vi.waitFor(() => expect(recognition).toBeDefined());
    expect(recognition.lang).toBe('en-IN'); expect(Socket.instances).toHaveLength(0);
    recognition.onresult({results:[{0:{transcript:'Open settings'},isFinal:true}]}); recognition.onend();
    expect(await result).toMatchObject({ok:true,data:{transcript:'Open settings',language:'en-IN'}});
    expect(hooks.send).toHaveBeenCalledWith(expect.objectContaining({requestId:'chrome-turn',transcript:'Open settings'}));
  });
});
