import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useCare } from './CareContext';
import { KIND, PANEL, groupEvents, kindsOf, photoEvent, timeSpan } from './model';
import { Button, Card, Photo, T } from './ui';

export function AlertCard({ alert, full, onOpenDoor }: { alert: any; full?: boolean; onOpenDoor?: () => void }) {
  const { state, token, call } = useCare();
  const colors = PANEL[alert.kind] || PANEL.motion;
  const bedside = full && state.settings.bedsideMode && alert.level === 'critical';
  const [clipNote, setClipNote] = useState(alert.clipNote || '');

  async function acknowledge() {
    try {
      await call(`/api/alerts/${alert.id}/ack`, { method: 'POST' });
    } catch {
      setClipNote('That alert is still open. Please try again.');
    }
  }

  async function playClip() {
    setClipNote('Getting the recording…');
    try {
      await call(`/api/events/${alert.id}/clip`, { method: 'POST' });
      setClipNote('');
    } catch (error) {
      setClipNote(error.message || 'No recording is available for this moment. The words still stand.');
    }
  }

  return (
    <View accessibilityRole="summary" style={[styles.panel, { backgroundColor: colors.bg }]}>
      <T style={[styles.badge, { color: colors.ink }]}>{bedside ? 'Bedside alert' : (KIND[alert.kind] || 'Notice')}</T>
      <T style={[styles.title, { color: colors.ink }]}>{alert.title}</T>
      <T style={{ color: colors.ink }}>{`${alert.localTime} · ${state.settings.deviceName}`}</T>
      {full ? <Photo path={alert.snapshotUrl} token={token} style={styles.wide} /> : null}
      {full && alert.snapshotNote ? <T style={{ color: colors.ink }}>{alert.snapshotNote}</T> : null}
      {full ? <T style={{ color: colors.ink }}>{alert.detail}</T> : null}
      {full && alert.chimeMessage ? <T style={{ color: colors.ink }}>{alert.chimeMessage}</T> : null}
      {full && clipNote ? <T style={{ color: colors.ink }}>{clipNote}</T> : null}
      {state.pending > 1 ? <T style={{ color: colors.ink }}>{`${state.pending - 1} more alert${state.pending - 1 === 1 ? '' : 's'}. Acknowledge this one to see the next.`}</T> : null}
      <View style={styles.row}>
        {full && state.mode === 'live' && !alert.sample && ['doorbell', 'person'].includes(alert.kind) && !alert.clipUrl ? (
          <Button label="Play the clip" onPress={playClip} />
        ) : null}
        {!full && onOpenDoor ? <Button label="Open the door view" onPress={onOpenDoor} /> : null}
        <Button label="I have seen this" onPress={acknowledge} />
      </View>
    </View>
  );
}

export default function DoorScreen() {
  const { state, token, call, setView } = useCare();
  const groups = groupEvents(state.today.moments || []);
  const door = state.door || {};
  const choices = door.choices || [];
  const [note, setNote] = useState('');

  async function chooseDoor(key) {
    try {
      await call('/api/door', { method: 'POST', body: JSON.stringify({ key }) });
      setNote('CareBell is watching that door.');
    } catch (error) {
      setNote(error.message || 'That door was not selected.');
    }
  }

  async function loadRecording() {
    setNote('');
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'] });
      if (picked.canceled || !picked.assets || !picked.assets[0]) return;
      const asset = picked.assets[0];
      const name = asset.fileName || 'clip.mp4';
      if (!/\.(mp4|mov|webm)$/i.test(name) && asset.mimeType && !/(mp4|quicktime|webm)/i.test(asset.mimeType)) {
        setNote('Use an MP4 or MOV door recording.');
        return;
      }
      const form = new FormData();
      if (asset.file) form.append('file', asset.file, name);
      else {
        const blob = await fetch(asset.uri).then((response) => response.blob());
        form.append('file', blob, name);
      }
      await call('/api/demo/video', { method: 'POST', body: form });
    } catch (error) {
      setNote(error.message || 'CareBell could not read that recording.');
    }
  }

  async function simulate(kind) {
    setNote('');
    try {
      await call('/api/demo', { method: 'POST', body: JSON.stringify({ kind }) });
    } catch {
      setNote('The practice event did not go through. Please try again.');
    }
  }

  const recent = groups.at(-1);
  const latest = recent
    ? `Latest: ${timeSpan(recent)} ${kindsOf(recent).map((kind) => KIND[kind]).join(', ')}`
    : 'No new activity at the door today.';

  return (
    <View style={styles.stack}>
      {state.paused ? (
        <Card>
          <T style={styles.heading}>Door watch is paused</T>
          <T>{state.pauseReason || 'Turn the subscription back on in Ring My Apps.'}</T>
        </Card>
      ) : null}
      {state.banner ? <AlertCard alert={state.banner} full onOpenDoor={() => setView('watch')} /> : (
        <View style={[styles.panel, { backgroundColor: '#e6f4ea' }]}>
          <T style={[styles.badge, { color: '#0f3d28' }]}>Quiet</T>
          <T style={[styles.title, { color: '#0f3d28' }]}>The door is quiet</T>
          <T style={{ color: '#0f3d28' }}>When someone presses the doorbell, this page shows large text and a color that matches the words.</T>
          <T style={{ color: '#0f3d28' }}>{latest}</T>
        </View>
      )}
      {state.mode === 'live' ? (
        <Card>
          <T style={styles.heading}>Door health</T>
          <T style={styles.health}>{door.line || (state.playground && state.playground.error) || 'Checking the doorbell…'}</T>
          {door.motion ? <T style={styles.health}>{door.motion}</T> : null}
          {choices.length > 1 ? (
            <View style={styles.stack}>
              <T style={styles.heading}>Which door to watch</T>
              {choices.map((choice) => (
                <Button key={choice.key} label={choice.watching ? `${choice.name} (watching)` : choice.name} tone={choice.watching ? 'primary' : 'plain'} onPress={() => chooseDoor(choice.key)} />
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}
      <Card>
        <T style={styles.heading}>At the door today</T>
        {groups.length ? groups.map((events) => {
          const named = events.find((event) => event.familiarName);
          const photo = photoEvent(events);
          return (
            <View key={events.map((event) => event.id).join('-')} style={styles.moment}>
              <T style={styles.when}>{timeSpan(events)}</T>
              <T>{kindsOf(events).map((kind) => KIND[kind] || 'Record').join(', ')}</T>
              {named ? <T style={styles.heading}>{named.title}</T> : null}
              {named && photo ? <Photo path={photo.snapshotUrl} token={token} /> : null}
            </View>
          );
        }) : <T>Nothing new today. Yesterday is in the family log.</T>}
      </Card>
      <Card>
        <T style={styles.heading}>Try a door recording</T>
        <T style={styles.hint}>Playground has no door recording. Choose an MP4 or MOV from this device. CareBell reads it here and does not send it to Ring.</T>
        <Button label="Look at this recording" onPress={loadRecording} />
      </Card>
      {state.mode === 'live' ? null : (
        <Card>
          <T style={styles.heading}>Try a practice event</T>
          <T style={styles.hint}>These buttons use the same checks as a real doorbell, so you can see the alert before a token is connected.</T>
          <View style={styles.row}>
            <Button label="Doorbell pressed" onPress={() => simulate('doorbell')} />
            <Button label="Someone at the door" onPress={() => simulate('person')} />
            <Button label="Car passed" onPress={() => simulate('vehicle')} />
            <Button label="Package at the door" onPress={() => simulate('package')} />
            <Button label="Someone has fallen" onPress={() => simulate('fall')} />
            <Button label="Waiting at the door" onPress={() => simulate('loitering')} />
            <Button label="Someone knocking" onPress={() => simulate('knock')} />
            <Button label="Missed check-in" onPress={() => simulate('anomaly')} />
          </View>
        </Card>
      )}
      {note ? <T accessibilityLiveRegion="polite">{note}</T> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  panel: { borderRadius: 18, padding: 16, gap: 8 },
  badge: { fontWeight: '700', letterSpacing: 0.4 },
  title: { fontSize: 32, fontWeight: '800', lineHeight: 38 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  heading: { fontSize: 24, fontWeight: '700' },
  health: { fontSize: 22, fontWeight: '700' },
  hint: { color: '#4a453e' },
  moment: { gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#ddd4c6' },
  when: { fontWeight: '700' },
  wide: { width: '100%', height: 220 }
});
