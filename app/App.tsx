import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, Vibration, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE, loadToken, request, saveToken } from './src/api';
import { CareContext } from './src/CareContext';
import { VIEWS, modeLine } from './src/model';
import { colors } from './src/ui';
import AuthScreen from './src/AuthScreen';
import DoorScreen, { AlertCard } from './src/DoorScreen';
import TodayScreen from './src/TodayScreen';
import LogScreen from './src/LogScreen';
import PeopleScreen from './src/PeopleScreen';
import CareScreen from './src/CareScreen';
import { matchCommand, pageWords, VIEW_LABEL } from './src/commands';
import { listenOnce, speak, stopSpeaking } from './src/voice';

function withoutSession(body: any) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  delete next.sessionToken;
  return next;
}

export default function App() {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<any>(null);
  const [view, setView] = useState('listen');
  const [fontSize, setFontSize] = useState(21);
  const [bootError, setBootError] = useState('');
  const [intro, setIntro] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [voiceOn, setVoiceOn] = useState(true);
  const [listening, setListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('');
  const stateRef = useRef(null);
  const viewRef = useRef(view);
  const listeningRef = useRef(false);
  stateRef.current = state;
  viewRef.current = view;
  listeningRef.current = listening;

  const applyModel = useCallback((body) => {
    if (body && body.today) setState(withoutSession(body));
    return withoutSession(body);
  }, []);

  const call = useCallback(async (path, options) => {
    try {
      const body = await request(path, options, token);
      return applyModel(body);
    } catch (error) {
      if (error.status === 401 && error.message === 'Please sign in.') {
        await saveToken('');
        setToken('');
        setState(null);
      }
      throw error;
    }
  }, [applyModel, token]);

  const signIn = useCallback(async (path, account) => {
    const body = await request(path, {
      method: 'POST',
      body: JSON.stringify(account)
    });
    if (body.sessionToken) {
      await saveToken(body.sessionToken);
      setToken(body.sessionToken);
    }
    applyModel(body);
    const seen = await AsyncStorage.getItem('carebell-intro');
    if (!seen) setIntro(true);
  }, [applyModel]);

  const signOut = useCallback(async () => {
    try {
      if (token) await request('/api/logout', { method: 'POST' }, token);
    } catch {
      /* The local session still ends. */
    }
    await saveToken('');
    setToken('');
    setState(null);
  }, [token]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const [savedToken, savedView, savedSize, seenIntro, savedVoice] = await Promise.all([
        loadToken(),
        AsyncStorage.getItem('carebell-view'),
        AsyncStorage.getItem('carebell-size'),
        AsyncStorage.getItem('carebell-intro'),
        AsyncStorage.getItem('carebell-voice')
      ]);
      if (cancel) return;
      if (savedView) setView(savedView);
      setFontSize(savedSize === 'standard' ? 17 : 21);
      setVoiceOn(savedVoice !== 'off');
      if (!savedToken) {
        setReady(true);
        return;
      }
      setToken(savedToken);
      try {
        const body = await request('/api/state', {}, savedToken);
        if (!cancel) applyModel(body);
        if (!cancel && !seenIntro) setIntro(true);
      } catch (error) {
        if (!cancel) {
          if (error.status === 401) {
            await saveToken('');
            setToken('');
          } else setBootError(error.message);
        }
      } finally {
        if (!cancel) setReady(true);
      }
    })();
    return () => { cancel = true; };
  }, [applyModel]);

  useEffect(() => {
    if (!token) return undefined;
    const timer = setInterval(() => {
      request('/api/state', {}, token).then(applyModel).catch((error) => {
        if (error.status === 401) {
          saveToken('').then(() => {
            setToken('');
            setState(null);
          });
        }
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [applyModel, token]);

  useEffect(() => {
    if (!token || Platform.OS !== 'web' || typeof EventSource === 'undefined') return undefined;
    const stream = new EventSource(`${API_BASE}/api/stream`, { withCredentials: true });
    stream.onmessage = (event) => {
      try { applyModel(JSON.parse(event.data)); } catch { /* ignore a partial frame */ }
    };
    return () => stream.close();
  }, [applyModel, token]);

  const bedsideId = state && state.banner && state.settings && state.settings.bedsideMode && state.banner.level === 'critical'
    ? state.banner.id
    : '';

  useEffect(() => {
    if (!bedsideId) return undefined;
    const pulse = () => Vibration.vibrate([180, 120, 180]);
    pulse();
    const timer = setInterval(pulse, 2800);
    return () => {
      clearInterval(timer);
      Vibration.cancel();
    };
  }, [bedsideId]);

  const bannerId = state && state.banner ? state.banner.id : '';
  useEffect(() => {
    if (!state || !state.banner) return;
    const text = `${state.banner.title}. ${state.banner.detail}`;
    setLiveText(text);
    AccessibilityInfo.announceForAccessibility(text);
    if (voiceOn && !listeningRef.current) speak(text);
  }, [bannerId, voiceOn]);

  function setVoice(next) {
    setVoiceOn(next);
    AsyncStorage.setItem('carebell-voice', next ? 'on' : 'off').catch(() => {});
    const line = next
      ? 'Speak alerts is on. New alerts will be read aloud.'
      : 'Speak alerts is off.';
    setVoiceStatus(line);
    if (next) speak(line);
    else stopSpeaking();
  }

  const value = useMemo(() => ({
    state,
    token,
    call,
    signIn,
    signOut,
    view,
    setView: (next) => {
      setView(next);
      AsyncStorage.setItem('carebell-view', next).catch(() => {});
    },
    fontSize
  }), [call, fontSize, signIn, signOut, state, token, view]);

  function chooseSize(size) {
    setFontSize(size === 'standard' ? 17 : 21);
    AsyncStorage.setItem('carebell-size', size).catch(() => {});
  }

  async function hearCommand() {
    if (listeningRef.current) return;
    setListening(true);
    setVoiceStatus('Listening. Say Door, Today, Family log, People, Care, read this, or I have seen this.');
    try {
      const transcript = await listenOnce();
      await applyCommand(matchCommand(transcript));
    } catch (error) {
      setVoiceStatus(error.message);
    } finally {
      setListening(false);
    }
  }

  async function applyCommand(command) {
    const current = stateRef.current;
    if (command.type === 'empty') {
      const line = 'CareBell did not hear anything. Please try again.';
      setVoiceStatus(line);
      speak(line);
      return;
    }
    if (command.type === 'unknown') {
      const line = 'That is not a door command. Say Door, Today, Family log, People, Care, or I have seen this.';
      setVoiceStatus(line);
      speak(line);
      return;
    }
    if (command.type === 'signout') {
      setVoiceStatus('Signed out.');
      speak('Signed out.');
      await signOut();
      return;
    }
    if (command.type === 'ack') {
      if (!current || !current.banner) {
        const line = 'There is no open alert.';
        setVoiceStatus(line);
        speak(line);
        return;
      }
      try {
        await call(`/api/alerts/${current.banner.id}/ack`, { method: 'POST' });
        setVoiceStatus('Alert acknowledged.');
        speak('Alert acknowledged.');
      } catch {
        setVoiceStatus('That alert is still open. Please try again.');
      }
      return;
    }
    if (command.type === 'size') {
      chooseSize(command.size);
      const line = command.size === 'large' ? 'Large text.' : 'Standard text.';
      setVoiceStatus(line);
      speak(line);
      return;
    }
    if (command.type === 'read') {
      const line = pageWords(current, viewRef.current);
      setVoiceStatus(line);
      speak(line);
      return;
    }
    if (command.type === 'view') {
      setView(command.view);
      AsyncStorage.setItem('carebell-view', command.view).catch(() => {});
      const line = `${VIEW_LABEL[command.view]}. ${pageWords(current, command.view)}`;
      setVoiceStatus(line);
      speak(line);
    }
  }

  const bedside = Boolean(state && state.banner && state.settings.bedsideMode && state.banner.level === 'critical');
  const screen = view === 'watch'
    ? <DoorScreen />
    : view === 'log'
      ? <LogScreen />
      : view === 'people'
        ? <PeopleScreen />
        : view === 'care'
          ? <CareScreen />
          : <TodayScreen />;

  return (
    <CareContext.Provider value={value}>
      <StatusBar style="dark" />
      <ScrollView style={styles.page} contentContainerStyle={styles.pageContent}>
        <Text style={styles.skip} accessibilityRole="header">CareBell</Text>
        <Text style={styles.eyebrow}>Door watch for someone living alone</Text>
        <Text style={styles.title}>CareBell</Text>
        <Text style={[styles.lede, { fontSize }]}>Turn what the doorbell sees into words the household can read, hear, and act on.</Text>
        {state ? (
          <View style={styles.sizeRow}>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: fontSize === 17 }} onPress={() => chooseSize('standard')} style={styles.sizeButton}>
              <Text>Standard text</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: fontSize === 21 }} onPress={() => chooseSize('large')} style={styles.sizeButton}>
              <Text>Large text</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={signOut} style={styles.sizeButton}>
              <Text>Sign out</Text>
            </Pressable>
          </View>
        ) : null}
        {state ? (
          <View style={styles.sizeRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ checked: voiceOn }}
              onPress={() => setVoice(!voiceOn)}
              style={[styles.sizeButton, voiceOn && styles.navOn]}
            >
              <Text style={voiceOn ? styles.navTextOn : styles.navText}>{voiceOn ? 'Speak alerts is on' : 'Speak alerts is off'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: listening }}
              disabled={listening}
              onPress={hearCommand}
              style={styles.sizeButton}
            >
              <Text style={styles.navText}>{listening ? 'Listening…' : 'Speak a command'}</Text>
            </Pressable>
          </View>
        ) : null}
        {state ? <Text style={styles.mode}>Say Door, Today, Family log, People, Care, read this, or I have seen this.</Text> : null}
        {state ? <Text accessibilityLiveRegion="polite" style={styles.mode}>{voiceStatus}</Text> : null}
        {state ? (
          <View style={styles.nav}>
            {VIEWS.map(([id, label]) => (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityState={{ selected: view === id }}
                onPress={() => value.setView(id)}
                style={[styles.navButton, view === id && styles.navOn]}
              >
                <Text style={[styles.navText, view === id && styles.navTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {state ? <Text style={styles.mode}>{modeLine(state)}</Text> : null}
        <Text accessibilityLiveRegion="assertive" style={styles.live}>{liveText}</Text>
        {!ready ? <Text style={{ fontSize }}>Opening door watch…</Text> : null}
        {ready && !state ? <AuthScreen /> : null}
        {bootError ? <Text style={{ fontSize }}>{bootError}</Text> : null}
        {state && state.banner && view !== 'watch' && !bedside ? (
          <AlertCard alert={state.banner} onOpenDoor={() => value.setView('watch')} />
        ) : null}
        {state ? screen : null}
        <Text style={styles.foot}>Records stay on this CareBell server for the family to review. Subscriptions and Chime volume are managed in Ring My Apps. The phone and web app call {API_BASE}.</Text>
      </ScrollView>
      <Modal visible={bedside} animationType="fade" onRequestClose={() => {}}>
        <View style={styles.bedside}>
          {state && state.banner ? <AlertCard alert={state.banner} full /> : null}
        </View>
      </Modal>
      <Modal visible={intro} animationType="slide" onRequestClose={() => setIntro(false)}>
        <View style={styles.intro}>
          <Text style={styles.title}>Door events, in words the household can use</Text>
          <Text style={styles.lede}>Door: large text and color when someone presses the bell.</Text>
          <Text style={styles.lede}>Today: one sentence about the day, which can be read aloud.</Text>
          <Text style={styles.lede}>People: name familiar people from a door photo, and remove them.</Text>
          <Text style={styles.lede}>Care: choose which events alert, set a morning check-in time, and paste a Ring Playground token.</Text>
          <Text style={styles.lede}>Voice: turn on Speak alerts to hear a new alert. Say Door, Today, or I have seen this.</Text>
          <Pressable accessibilityRole="button" style={styles.navOn} onPress={async () => {
            await AsyncStorage.setItem('carebell-intro', '1');
            setIntro(false);
          }}>
            <Text style={styles.navTextOn}>Start</Text>
          </Pressable>
        </View>
      </Modal>
    </CareContext.Provider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  pageContent: { padding: 20, gap: 12, maxWidth: 920, width: '100%', alignSelf: 'center' },
  skip: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
  eyebrow: { color: colors.brand, fontWeight: '700' },
  title: { fontSize: 40, fontWeight: '800', color: colors.ink },
  lede: { color: colors.ink, lineHeight: 28, maxWidth: 640 },
  sizeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sizeButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, backgroundColor: colors.card },
  nav: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  navButton: { minHeight: 48, minWidth: 120, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 2, borderColor: colors.line, backgroundColor: colors.card },
  navOn: { backgroundColor: colors.brand, borderColor: colors.brand, minHeight: 48, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  navText: { fontSize: 18, fontWeight: '700', color: colors.ink },
  navTextOn: { fontSize: 18, fontWeight: '700', color: '#fffdf8' },
  mode: { color: colors.muted, fontSize: 16 },
  live: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
  foot: { color: colors.muted, marginTop: 12 },
  bedside: { flex: 1, backgroundColor: '#7a1d1d', justifyContent: 'center', padding: 16 },
  intro: { flex: 1, backgroundColor: colors.bg, padding: 24, gap: 12, justifyContent: 'center' }
});
