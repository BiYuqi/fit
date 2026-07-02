import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { jest } from '@jest/globals';
import '@testing-library/jest-native/extend-expect';

import { ChatInput } from '../chat-input';

// ─── Voice event listeners captured per event name ────────────────────────
const voiceListeners: Record<string, (event: any) => void> = {};

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
    requestPermissionsAsync: jest.fn<() => Promise<{ granted: boolean }>>(),
  },
  useSpeechRecognitionEvent: (event: string, callback: (event: any) => void) => {
    voiceListeners[event] = callback;
  },
}));

// Refs to mocked module methods for assertions
import { ExpoSpeechRecognitionModule as SpeechMod } from 'expo-speech-recognition';
const mockSpeech = SpeechMod as unknown as {
  start: jest.Mock;
  stop: jest.Mock;
  abort: jest.Mock;
  requestPermissionsAsync: jest.Mock<() => Promise<{ granted: boolean }>>;
};

jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));
jest.mock('expo-symbols', () => ({ SymbolView: 'SymbolView' }));
jest.mock('@/hooks/use-color-scheme', () => ({ useColorScheme: () => 'light' }));

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Fire a voice event via the captured useSpeechRecognitionEvent callback. */
function fireVoiceEvent(event: string, payload?: any) {
  act(() => {
    voiceListeners[event]?.(payload ?? {});
  });
}

/** Shortcut: fire a 'result' event with a transcript. */
function fireVoiceResult(transcript: string) {
  fireVoiceEvent('result', { results: [{ transcript }] });
}

async function tapMic() {
  await act(async () => {
    await fireEvent.press(screen.getByTestId('mic-btn'));
  });
}

async function tapSend() {
  await act(async () => {
    await fireEvent.press(screen.getByTestId('send-btn'));
  });
}

function typeText(value: string) {
  act(() => {
    fireEvent.changeText(screen.getByPlaceholderText(/记录你吃了/), value);
  });
}

function renderInput(opts?: { onSend?: jest.Mock; isSending?: boolean }) {
  return render(
    <ChatInput onSend={opts?.onSend ?? jest.fn()} isSending={opts?.isSending ?? false} />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(voiceListeners).forEach(k => delete voiceListeners[k]);
  mockSpeech.requestPermissionsAsync.mockResolvedValue({ granted: true });
});

// ─── Voice lifecycle ───────────────────────────────────────────────────────
describe('voice lifecycle', () => {
  it('tapping mic starts recognition', async () => {
    renderInput();
    await tapMic();
    expect(mockSpeech.start).toHaveBeenCalledWith({
      lang: 'zh-CN',
      interimResults: true,
      continuous: true,
    });
  });

  it('tapping mic while listening stops it', async () => {
    renderInput();
    // Push into listening state first
    mockSpeech.start.mockImplementation(() => fireVoiceEvent('start'));

    await tapMic(); // start
    expect(mockSpeech.start).toHaveBeenCalled();

    await tapMic(); // stop
    expect(mockSpeech.stop).toHaveBeenCalled();
  });

  it('does not start if permission denied', async () => {
    mockSpeech.requestPermissionsAsync.mockResolvedValue({ granted: false });
    renderInput();
    await tapMic();
    expect(mockSpeech.start).not.toHaveBeenCalled();
  });

  it('end event clears listening state', () => {
    renderInput();
    fireVoiceEvent('start');
    fireVoiceEvent('end');
    // End from system — stop() not called by us
    expect(mockSpeech.stop).not.toHaveBeenCalled();
  });

  it('error event clears listening state', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderInput();
    fireVoiceEvent('start');
    fireVoiceEvent('error', { error: 'no-speech', message: 'No speech' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── Text streaming ────────────────────────────────────────────────────────
describe('voice text streaming', () => {
  it('sets text from voice result', () => {
    renderInput();
    fireVoiceResult('我吃了米饭');
    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('我吃了米饭');
  });

  it('updates text with each partial result', () => {
    renderInput();
    fireVoiceResult('我吃');
    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('我吃');
    fireVoiceResult('我吃了米饭');
    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('我吃了米饭');
  });

  it('ignores empty result', () => {
    renderInput();
    fireVoiceEvent('result', { results: [] });
    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('');
  });
});

// ─── Existing text preserved on record ────────────────────────────────────
describe('existing text preserved', () => {
  it('prepends existing text when recording starts', async () => {
    mockSpeech.start.mockImplementation(() => fireVoiceEvent('start'));
    renderInput();

    typeText('我吃了');
    await tapMic();
    fireVoiceResult('一碗米饭');

    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('我吃了一碗米饭');
  });

  it('empty initial text works normally', async () => {
    mockSpeech.start.mockImplementation(() => fireVoiceEvent('start'));
    renderInput();

    await tapMic();
    fireVoiceResult('一碗米饭');

    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('一碗米饭');
  });
});

// ─── Send during recording ─────────────────────────────────────────────────
describe('send during recording', () => {
  it('send while listening stops voice and clears text', async () => {
    renderInput();
    typeText('临时');
    fireVoiceEvent('start');

    await tapSend();

    expect(mockSpeech.stop).toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('');
  });

  it('send calls onSend when not listening', async () => {
    const onSend = jest.fn();
    renderInput({ onSend });

    typeText('正常文字');
    await tapSend();

    expect(onSend).toHaveBeenCalledWith('正常文字');
    expect(screen.getByPlaceholderText(/记录你吃了/).props.value).toBe('');
  });
});

// ─── Manual edit during recording ──────────────────────────────────────────
describe('manual edit during recording', () => {
  it('manual change during recording stops voice', () => {
    renderInput();
    fireVoiceEvent('start');
    // User manually edits — voiceSetRef is false → stop fires
    typeText('手打');
    expect(mockSpeech.stop).toHaveBeenCalled();
  });

  it('voice-driven change does not stop recording', () => {
    renderInput();
    fireVoiceEvent('start');
    // voiceSetRef=true before setText → handleChangeText skips stop
    fireVoiceResult('语音文字');
    expect(mockSpeech.stop).not.toHaveBeenCalled();
  });
});
