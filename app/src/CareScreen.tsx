import { useState } from 'react';
import { Modal, StyleSheet, Switch, View } from 'react-native';
import { useCare } from './CareContext';
import { Button, Card, Choice, Field, T } from './ui';

const DAYS = [['every', 'Every day'], ['weekdays', 'Weekdays'], ['weekends', 'Weekends']];
const KINDS = [
  ['by', 'By a time'],
  ['between', 'Between times'],
  ['stay', 'Keeps appearing']
];
const WHAT = [
  ['doorbell', 'Doorbell'],
  ['person', 'Someone'],
  ['familiar', 'Familiar person'],
  ['vehicle', 'Car'],
  ['motion', 'Movement'],
  ['activity', 'Any activity']
];
const ACTIONS = [
  ['alert', 'Show an alert'],
  ['contact', 'Alert and tell the contact']
];
type RuleDraft = { kind: string; time: string; end: string; days: string; condition: string; action: string; minutes: string };
const PRESETS: [string, RuleDraft][] = [
  ['Quiet by 10:00', { kind: 'by', time: '10:00', end: '10:00', days: 'every', condition: 'activity', action: 'contact', minutes: '3' }],
  ['Doorbell after 21:00', { kind: 'between', time: '21:00', end: '07:00', days: 'every', condition: 'doorbell', action: 'alert', minutes: '3' }],
  ['Familiar person by 18:30 on weekdays', { kind: 'by', time: '18:30', end: '18:30', days: 'weekdays', condition: 'familiar', action: 'contact', minutes: '3' }],
  ['Someone stays 3 minutes', { kind: 'stay', time: '10:00', end: '10:00', days: 'every', condition: 'person', action: 'alert', minutes: '3' }]
];

function Check({ label, value, onValueChange }) {
  return (
    <View style={styles.check}>
      <T style={styles.checkLabel}>{label}</T>
      <Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} />
    </View>
  );
}

export default function CareScreen() {
  const { state, call } = useCare();
  const settings = state.settings;
  const [deviceName, setDeviceName] = useState(settings.deviceName || '');
  const [emergencyName, setEmergencyName] = useState(settings.emergencyName || '');
  const [checkInBy, setCheckInBy] = useState(settings.checkInBy || '10:00');
  const [leaveBy, setLeaveBy] = useState(settings.leaveBy || '08:15');
  const [homeBy, setHomeBy] = useState(settings.homeBy || '18:30');
  const [alerts, setAlerts] = useState({ ...settings.alerts });
  const [anomalyEnabled, setAnomalyEnabled] = useState(Boolean(settings.anomalyEnabled));
  const [playChime, setPlayChime] = useState(Boolean(settings.playChimeOnDoorbell));
  const [lateHome, setLateHome] = useState(settings.lateHomeEnabled !== false);
  const [bedside, setBedside] = useState(settings.bedsideMode !== false);
  const [status, setStatus] = useState('');
  const [sentence, setSentence] = useState('');
  const [rule, setRule] = useState({ kind: 'by', time: '10:00', end: '07:00', days: 'every', condition: 'activity', action: 'alert', minutes: '3' });
  const [playground, setPlayground] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = settings.rules || [];
  const playgroundState = state.playground || {};

  function setRuleField(key, value) {
    setRule((current) => ({ ...current, [key]: value }));
  }

  async function saveSettings() {
    setStatus('');
    try {
      await call('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          deviceName,
          emergencyName,
          checkInBy,
          leaveBy,
          homeBy,
          anomalyEnabled,
          lateHomeEnabled: lateHome,
          bedsideMode: bedside,
          playChimeOnDoorbell: playChime,
          alerts
        })
      });
      setStatus('Saved.');
    } catch {
      setStatus('Settings were not saved. Please try again.');
    }
  }

  async function saveRule() {
    setStatus('');
    const text = sentence.trim();
    try {
      await call('/api/rules', {
        method: 'POST',
        body: JSON.stringify(text ? { text } : {
          kind: rule.kind,
          time: rule.time,
          end: rule.end,
          days: rule.days,
          condition: rule.condition,
          action: rule.action,
          minutes: Number(rule.minutes) || 3
        })
      });
      setSentence('');
      setStatus('Rule saved.');
    } catch (error) {
      setStatus(error.message || 'That rule was not saved.');
    }
  }

  const playgroundLine = playgroundState.error
    ? playgroundState.error
    : playgroundState.connected && playgroundState.source === 'ring'
      ? `Connected${playgroundState.deviceName ? ` to ${playgroundState.deviceName}` : ''} through your Ring account. The connection stays on this server.`
      : playgroundState.connected
        ? `Connected${playgroundState.deviceName ? ` to ${playgroundState.deviceName}` : ''}. The token stays on this server and is not shown again. It lasts about 30 minutes.`
        : 'Not connected. Generate a token in the Ring Playground, then paste it here.';

  return (
    <View style={styles.stack}>
      {state.chimeLine ? (
        <Card>
          <T style={styles.heading}>Chime</T>
          <T style={styles.health}>{state.chimeLine}</T>
        </Card>
      ) : null}
      <Card>
        <T style={styles.heading}>Alert rules</T>
        <T style={styles.hint}>A written rule is saved only when it names a time and something at the door. Anything else is refused.</T>
        {!saved.length ? <T>No custom rules yet.</T> : null}
        {saved.map((item) => (
          <View key={item.id} style={styles.rule}>
            <T>{item.sentence}</T>
            <Button label="Remove this rule" onPress={async () => {
              try {
                await call(`/api/rules/${item.id}`, { method: 'DELETE' });
              } catch (error) {
                setStatus(error.message || 'That rule is still saved.');
              }
            }} />
          </View>
        ))}
        <View style={styles.row}>
          {PRESETS.map(([label, preset]) => (
            <Button key={label} label={label} onPress={() => setRule(preset)} />
          ))}
        </View>
        <T style={styles.label}>When</T>
        <View style={styles.row}>
          {KINDS.map(([value, label]) => (
            <Choice key={value} label={label} selected={rule.kind === value} onPress={() => setRuleField('kind', value)} />
          ))}
        </View>
        {rule.kind !== 'stay' ? <Field label="Time" value={rule.time} onChangeText={(value) => setRuleField('time', value)} placeholder="10:00" /> : null}
        {rule.kind === 'between' ? <Field label="Until" value={rule.end} onChangeText={(value) => setRuleField('end', value)} placeholder="07:00" /> : null}
        {rule.kind === 'stay' ? (
          <View style={styles.stack}>
            <Field label="Minutes at the door" value={String(rule.minutes)} onChangeText={(value) => setRuleField('minutes', value.replace(/[^\d]/g, ''))} keyboardType="number-pad" />
            <T style={styles.hint}>CareBell compares the door photos Ring already saved. A person you named can be recognized. A stranger is not named.</T>
          </View>
        ) : null}
        <T style={styles.label}>Days</T>
        <View style={styles.row}>
          {DAYS.map(([value, label]) => (
            <Choice key={value} label={label} selected={rule.days === value} onPress={() => setRuleField('days', value)} />
          ))}
        </View>
        <T style={styles.label}>What at the door</T>
        <View style={styles.row}>
          {WHAT.map(([value, label]) => (
            <Choice key={value} label={label} selected={rule.condition === value} onPress={() => setRuleField('condition', value)} />
          ))}
        </View>
        <T style={styles.label}>What to do</T>
        <View style={styles.row}>
          {ACTIONS.map(([value, label]) => (
            <Choice key={value} label={label} selected={rule.action === value} onPress={() => setRuleField('action', value)} />
          ))}
        </View>
        <Field label="Or describe a rule" value={sentence} onChangeText={setSentence} placeholder="Alert me if nobody has been at the door by 10:00" />
        <Button label="Add this rule" tone="primary" onPress={saveRule} />
      </Card>
      {state.ringApp && state.ringApp.configured ? (
        <Card>
          <T style={styles.heading}>Ring app</T>
          <T style={styles.hint}>{state.playground && state.playground.source === 'ring'
            ? 'This CareBell account is linked to Ring. Door events, photos, live view, and the Chime use that connection.'
            : 'Credentials for ring-care are saved on this server. In the Ring developer portal, set these paths on your public HTTPS address, then open CareBell from the Ring app and sign in.'}</T>
          <T>{`Token exchange: ${state.ringApp.tokenExchange}`}</T>
          <T>{`Account link: ${state.ringApp.accountLink}`}</T>
          <T>{`Webhook: ${state.ringApp.webhook}`}</T>
        </Card>
      ) : null}
      <Card>
        <T style={styles.heading}>Ring Playground</T>
        <T accessibilityLiveRegion="polite">{playgroundLine}</T>
        <Field label="Playground token" value={playground} onChangeText={setPlayground} secureTextEntry autoCapitalize="none" autoCorrect={false} />
        <View style={styles.row}>
          <Button label="Connect" tone="primary" onPress={async () => {
            try {
              await call('/api/playground', { method: 'POST', body: JSON.stringify({ token: playground.trim() }) });
              setPlayground('');
              setStatus('Connected.');
            } catch (error) {
              setStatus(error.message || 'Ring did not accept that token.');
            }
          }} />
          {playgroundState.connected ? <Button label="Disconnect" onPress={async () => {
            try {
              await call('/api/playground', { method: 'DELETE' });
              setStatus('Disconnected.');
            } catch {
              setStatus('Could not disconnect. Please try again.');
            }
          }} /> : null}
        </View>
      </Card>
      <Card>
        <T style={styles.heading}>Care settings</T>
        <T style={styles.hint}>Choose which events should alert. Unselected events stay in the family log. Use 24-hour times, like 08:15.</T>
        <Field label="Door name" value={deviceName} onChangeText={setDeviceName} />
        <Field label="Emergency contact" value={emergencyName} onChangeText={setEmergencyName} />
        <Check label="Someone pressed the doorbell" value={Boolean(alerts.doorbell)} onValueChange={(value) => setAlerts((current) => ({ ...current, doorbell: value }))} />
        <Check label="Someone at the door" value={Boolean(alerts.person)} onValueChange={(value) => setAlerts((current) => ({ ...current, person: value }))} />
        <Check label="A car passed" value={Boolean(alerts.vehicle)} onValueChange={(value) => setAlerts((current) => ({ ...current, vehicle: value }))} />
        <Check label="Small movement at the door" value={Boolean(alerts.motion)} onValueChange={(value) => setAlerts((current) => ({ ...current, motion: value }))} />
        <Check label="A package left at the door" value={alerts.package !== false} onValueChange={(value) => setAlerts((current) => ({ ...current, package: value }))} />
        <Check label="Someone may have fallen" value={alerts.fall !== false} onValueChange={(value) => setAlerts((current) => ({ ...current, fall: value }))} />
        <Check label="Someone waiting at the door" value={alerts.loitering !== false} onValueChange={(value) => setAlerts((current) => ({ ...current, loitering: value }))} />
        <Check label="Someone knocking at the door" value={alerts.knock !== false} onValueChange={(value) => setAlerts((current) => ({ ...current, knock: value }))} />
        <T style={styles.hint}>When the doorbell saved a recording, CareBell reads frames from that clip on this computer. If there is only a still picture, it uses that. It does not name a stranger, and it does not listen for a knock.</T>
        <Field label="Latest time for activity" value={checkInBy} onChangeText={setCheckInBy} />
        <Check label="Alert if there is no activity by this time" value={anomalyEnabled} onValueChange={setAnomalyEnabled} />
        <Check label="Play a sound when someone presses the doorbell" value={playChime} onValueChange={setPlayChime} />
        <Field label="Leaves by" value={leaveBy} onChangeText={setLeaveBy} />
        <Field label="Usually home by" value={homeBy} onChangeText={setHomeBy} />
        <Check label="Alert if nobody is home by this time" value={lateHome} onValueChange={setLateHome} />
        <Check label="Bedside mode: full-screen words and a repeating pulse until you tap I have seen this" value={bedside} onValueChange={setBedside} />
        <T style={styles.hint}>{state.chimeNote}</T>
        <T style={styles.hint}>Pictures come from photos the doorbell already saved. If none exists, the large-text alert still stands.</T>
        <Button label="Save care settings" tone="primary" onPress={saveSettings} />
        <T accessibilityLiveRegion="polite">{status}</T>
        <View style={styles.row}>
          {state.mode === 'live' ? null : <Button label="Restore the sample day" onPress={async () => {
            try {
              await call('/api/sample', { method: 'POST' });
              setStatus('The sample day is back in the log.');
            } catch {
              setStatus('The sample day was not restored. Please try again.');
            }
          }} />}
          <Button label="Delete door records" tone="danger" onPress={() => setConfirmDelete(true)} />
        </View>
      </Card>
      {state.mode === 'live' ? null : (
        <Card>
          <T style={styles.heading}>Try a practice event</T>
          <View style={styles.row}>
            <Button label="Doorbell pressed" onPress={() => call('/api/demo', { method: 'POST', body: JSON.stringify({ kind: 'doorbell' }) }).catch(() => setStatus('The practice event did not go through. Please try again.'))} />
            <Button label="Someone at the door" onPress={() => call('/api/demo', { method: 'POST', body: JSON.stringify({ kind: 'person' }) }).catch(() => setStatus('The practice event did not go through. Please try again.'))} />
          </View>
        </Card>
      )}
      <Modal visible={confirmDelete} transparent animationType="fade" onRequestClose={() => setConfirmDelete(false)}>
        <View style={styles.backdrop}>
          <Card>
            <T style={styles.heading}>Delete the household door records?</T>
            <T>Pictures, alerts, and peace-of-mind reports are deleted. Care settings stay.</T>
            <View style={styles.row}>
              <Button label="Delete" tone="danger" onPress={async () => {
                try {
                  await call('/api/household-data', { method: 'DELETE' });
                  setConfirmDelete(false);
                  setStatus('Door records deleted.');
                } catch {
                  setStatus('Nothing was deleted. Please try again.');
                  setConfirmDelete(false);
                }
              }} />
              <Button label="Keep them" onPress={() => setConfirmDelete(false)} />
            </View>
          </Card>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  heading: { fontSize: 26, fontWeight: '700' },
  health: { fontSize: 22, fontWeight: '700' },
  hint: { color: '#4a453e' },
  label: { fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rule: { gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#ddd4c6' },
  check: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  checkLabel: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(28,25,21,0.45)', justifyContent: 'center', padding: 20 }
});
