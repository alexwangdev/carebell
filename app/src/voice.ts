import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

const COMMANDS = ['Door', 'Today', 'Family log', 'People', 'Care', 'I have seen this', 'Read this aloud', 'Sign out'];

export function speak(text: string, handlers: { onDone?: () => void; onStopped?: () => void; onError?: () => void } = {}): void {
  const value = String(text || '').trim();
  if (!value) return;
  Speech.stop();
  Speech.speak(value, {
    language: 'en-US',
    rate: 0.9,
    onDone: handlers.onDone,
    onStopped: handlers.onStopped,
    onError: handlers.onError
  });
}

export function stopSpeaking() {
  Speech.stop();
}

export function listenOnce(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      reject(new Error('This device cannot hear speech. Use Chrome, or turn on speech recognition in the phone settings.'));
      return;
    }
    let settled = false;
    let heard = '';
    const subscriptions: { remove: () => void }[] = [];
    const timer = setTimeout(() => finish(heard), 12000);
    const finish = (value: string, error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.remove());
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* already stopped */ }
      if (error) reject(error);
      else resolve(value);
    };
    subscriptions.push(ExpoSpeechRecognitionModule.addListener('result', (event) => {
      if (!event.isFinal) return;
      heard = String(event.results && event.results[0] ? event.results[0].transcript : '').trim();
    }));
    subscriptions.push(ExpoSpeechRecognitionModule.addListener('error', (event) => {
      const quiet = event.error === 'aborted' || event.error === 'no-speech' || event.error === 'speech-timeout';
      if (quiet) {
        finish(heard);
        return;
      }
      const blocked = event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture';
      finish('', new Error(blocked
        ? 'The microphone is off. Allow the microphone, then try the command again.'
        : 'CareBell did not catch that. Please try again.'));
    }));
    subscriptions.push(ExpoSpeechRecognitionModule.addListener('nomatch', () => finish('')));
    subscriptions.push(ExpoSpeechRecognitionModule.addListener('end', () => finish(heard)));
    stopSpeaking();
    const allow = Platform.OS === 'web'
      ? Promise.resolve({ granted: true })
      : ExpoSpeechRecognitionModule.requestPermissionsAsync();
    allow.then((permission) => {
      if (settled) return;
      if (!permission.granted) {
        finish('', new Error('The microphone is off. Allow the microphone, then try the command again.'));
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: false,
        contextualStrings: COMMANDS
      });
    }).catch(() => {
      finish('', new Error('The microphone is off. Allow the microphone, then try the command again.'));
    });
  });
}
