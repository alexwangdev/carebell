import { useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useCare } from './CareContext';
import { KIND, groupEvents, kindsOf, photoEvent, timeSpan } from './model';
import { Button, Card, Field, Photo, T } from './ui';

export default function LogScreen() {
  const { state, token, call } = useCare();
  const [day, setDay] = useState('all');
  const [kind, setKind] = useState('all');
  const [remember, setRemember] = useState<any>(null);
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('Daughter');
  const [note, setNote] = useState('');
  const days = [
    ['all', 'All days'],
    [state.today.date, 'Today'],
    [state.yesterday.date, 'Yesterday']
  ];
  const kinds = [['all', 'All'], ['doorbell', 'Doorbell'], ['person', 'Person'], ['vehicle', 'Vehicle'], ['motion', 'Motion'], ['package', 'Package'], ['knock', 'Knock'], ['loitering', 'Waiting'], ['fall', 'Fall'], ['anomaly', 'Alert'], ['late', 'Late'], ['rule', 'Rule']];
  const rows = (state.log || []).filter((event) => {
    if (day !== 'all' && event.localDate !== day) return false;
    if (kind === 'all') return true;
    return event.kind === kind;
  });
  let shownDate = '';

  async function savePerson() {
    if (!remember) return;
    try {
      await call('/api/people', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), relationship: relation.trim(), eventId: remember.id })
      });
      setNote(`${name.trim()} will be recognized from similar door photos.`);
      setRemember(null);
    } catch (error) {
      setNote(error.message || 'That person was not saved.');
    }
  }

  return (
    <View style={styles.stack}>
      <T style={styles.heading}>The family door log</T>
      <View style={styles.row}>
        {days.map(([value, label]) => (
          <Button key={value} label={label} tone={day === value ? 'primary' : 'plain'} onPress={() => setDay(value)} />
        ))}
      </View>
      <View style={styles.row}>
        {kinds.map(([value, label]) => (
          <Button key={value} label={label} tone={kind === value ? 'primary' : 'plain'} onPress={() => setKind(value)} />
        ))}
      </View>
      {!rows.length ? <T>No records match. Doorbell and door activity show up here for the family.</T> : null}
      {groupEvents(rows).map((events) => {
        const lead = events[0];
        const showDay = day === 'all' && lead.localDate !== shownDate;
        if (showDay) shownDate = lead.localDate;
        const dayName = lead.localDate === state.today.date ? 'Today' : (lead.localDate === state.yesterday.date ? 'Yesterday' : lead.localDate);
        const photo = photoEvent(events);
        const named = events.find((event) => event.familiarName);
        const alone = events.length === 1 && !['doorbell', 'person', 'vehicle', 'motion'].includes(lead.kind);
        const notes: string[] = [];
        if (events.some((event) => event.sample)) notes.push('Sample');
        if (events.some((event) => event.notified)) notes.push('Alerted');
        return (
          <View key={events.map((event) => event.id).join('-')}>
            {showDay ? <T style={styles.day}>{dayName}</T> : null}
            <Card>
              <T accessibilityLabel={`${timeSpan(events)}. ${kindsOf(events).map((item) => KIND[item] || 'Record').join(', ')}.`} style={styles.when}>{timeSpan(events)}</T>
              <T>{kindsOf(events).map((item) => KIND[item] || 'Record').join(', ')}</T>
              {photo ? <Photo path={photo.snapshotUrl} token={token} /> : null}
              {named ? <T style={styles.day}>{named.title}</T> : (alone ? <T style={styles.day}>{lead.title}</T> : null)}
              {named ? <T>{named.detail}</T> : (alone ? <T>{lead.detail}</T> : null)}
              {photo ? <Button label="This is someone I know" onPress={() => { setRemember(photo); setName(''); setRelation('Daughter'); }} /> : null}
              {notes.length ? <T style={styles.hint}>{notes.join(' · ')}</T> : null}
            </Card>
          </View>
        );
      })}
      {note ? <T accessibilityLiveRegion="polite">{note}</T> : null}
      <Modal visible={Boolean(remember)} animationType="slide" onRequestClose={() => setRemember(null)}>
        <View style={styles.modal}>
          <T style={styles.heading}>Who is in this photo?</T>
          <T>Ring sent this photo. Ring does not return a name. A later photo that looks like this one is titled with the name you choose, for example “Mia is at the door.” The person is saved on the People page.</T>
          {remember ? <Photo path={remember.snapshotUrl} token={token} style={styles.wide} /> : null}
          <Field label="Name" value={name} onChangeText={setName} />
          <Field label="Relationship" value={relation} onChangeText={setRelation} />
          <View style={styles.row}>
            <Button label="Save" tone="primary" onPress={savePerson} />
            <Button label="Cancel" onPress={() => setRemember(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  heading: { fontSize: 26, fontWeight: '700' },
  day: { fontSize: 20, fontWeight: '700' },
  when: { fontWeight: '700' },
  hint: { color: '#4a453e' },
  modal: { flex: 1, backgroundColor: '#f3eee4', padding: 20, gap: 12 },
  wide: { width: '100%', height: 220 }
});
