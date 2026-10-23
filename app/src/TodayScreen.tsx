import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useCare } from './CareContext';
import { latestClipEvent } from './model';
import { Button, Card, T } from './ui';
import { speak, stopSpeaking } from './voice';

function Speak({ text }) {
  const [speaking, setSpeaking] = useState(false);
  return (
    <Button
      label={speaking ? 'Stop' : 'Read this aloud'}
      tone="primary"
      onPress={() => {
        if (speaking) {
          stopSpeaking();
          setSpeaking(false);
          return;
        }
        setSpeaking(true);
        speak(text, {
          onDone: () => setSpeaking(false),
          onStopped: () => setSpeaking(false),
          onError: () => setSpeaking(false)
        });
      }}
    />
  );
}

function Clip({ event }) {
  const { state, call } = useCare();
  const [note, setNote] = useState('');
  if (!event) return null;
  if (event.clipUrl) {
    return <T>{event.clipNote || 'This is the recording from that moment at the door. Open the family log on the web app to play it.'}</T>;
  }
  if (state.mode !== 'live' || event.sample || !event.id) return null;
  return (
    <View style={styles.stack}>
      <Button label="Play the clip" onPress={async () => {
        setNote('Getting the recording…');
        try {
          await call(`/api/events/${event.id}/clip`, { method: 'POST' });
          setNote(Platform.OS === 'web' ? 'The recording is ready in the family log.' : 'The recording is saved. Play it from the web app.');
        } catch (error) {
          setNote(error.message || 'No recording is available for this moment. The words still stand.');
        }
      }} />
      {note ? <T accessibilityLiveRegion="polite">{note}</T> : null}
    </View>
  );
}

export default function TodayScreen() {
  const { state } = useCare();
  const source = state.today.source === 'bedrock' ? 'Rewritten with AI.' : 'Written from the door record.';
  const yesterdayClip = [...(state.log || [])].find((event) => event.localDate === state.yesterday.date && ['doorbell', 'person'].includes(event.kind));
  return (
    <View style={styles.stack}>
      <Card>
        <T accessibilityLiveRegion="polite" style={styles.heading}>{state.today.label}</T>
        <T style={styles.summary}>{state.today.summary}</T>
        <T style={styles.hint}>{source}</T>
        <Speak text={state.today.summary} />
        <Clip event={latestClipEvent(state.today.moments)} />
      </Card>
      <Card>
        <T style={styles.heading}>{state.yesterday.label}</T>
        {state.yesterday.sample ? <T style={styles.hint}>This is a sample, so you can see what a peace-of-mind report looks like.</T> : null}
        <T style={styles.summary}>{state.yesterday.summary}</T>
        <Speak text={state.yesterday.summary} />
        <Clip event={yesterdayClip} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  heading: { fontSize: 26, fontWeight: '700' },
  summary: { fontSize: 22 },
  hint: { color: '#4a453e' }
});
