import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useCare } from './CareContext';
import { Button, Card, Field, Photo, T } from './ui';

export default function PeopleScreen() {
  const { state, token, call } = useCare();
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('Daughter');
  const [status, setStatus] = useState('');
  const people = state.people || [];

  async function add(body, success) {
    if (!name.trim()) {
      setStatus('Enter the person’s name.');
      return;
    }
    setStatus('');
    try {
      await call('/api/people', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), relationship: relation.trim(), ...body })
      });
      setName('');
      setStatus(success);
    } catch (error) {
      setStatus(error.message || 'That person was not saved.');
    }
  }

  async function chooseJpeg() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8
    });
    if (result.canceled || !result.assets || !result.assets[0]) return;
    const asset = result.assets[0];
    const mime = asset.mimeType || '';
    const fileName = asset.fileName || asset.uri || '';
    if ((mime && !/jpe?g/i.test(mime)) || (!mime && !/\.jpe?g$/i.test(fileName))) {
      setStatus('Use a JPEG photo.');
      return;
    }
    if (!asset.base64) {
      setStatus('Use a JPEG photo.');
      return;
    }
    await add({ image: `data:image/jpeg;base64,${asset.base64}` }, 'Saved. A matching door photo will use this name.');
  }

  return (
    <View style={styles.stack}>
      <Card>
        <T style={styles.heading}>Familiar people</T>
        <T style={styles.hint}>Ring reports a person and sends the photo. Ring does not return a name. You choose the name. A later photo that looks like this one is titled with that name, for example “Mia is at the door.”</T>
        {!people.length ? <T>No familiar people yet. Add a JPEG, or label a door photo from the family log.</T> : null}
        {people.map((person) => (
          <View key={person.id} style={styles.person}>
            <Photo path={person.photoUrl} token={token} />
            <View style={styles.personText}>
              <T style={styles.name}>{person.name}</T>
              <T>{person.relationship}</T>
              <Button label="Remove this person" onPress={async () => {
                try {
                  await call(`/api/people/${person.id}`, { method: 'DELETE' });
                } catch {
                  setStatus('That person is still saved. Please try again.');
                }
              }} />
            </View>
          </View>
        ))}
      </Card>
      <Card>
        <T style={styles.heading}>Add a person</T>
        <T style={styles.hint}>Use the latest photo Ring already saved, or choose a JPEG from the door. Photos stay on this server. A person you named can be recognized. A stranger is not named.</T>
        <Field label="Name" value={name} onChangeText={setName} />
        <Field label="Relationship" value={relation} onChangeText={setRelation} />
        <View style={styles.row}>
          <Button label="Choose a JPEG" tone="primary" onPress={chooseJpeg} />
          <Button label="Use the latest Ring photo" onPress={() => add({ source: 'ring' }, 'Saved from the Ring door photo.')} />
        </View>
        <T accessibilityLiveRegion="polite">{status}</T>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  heading: { fontSize: 26, fontWeight: '700' },
  hint: { color: '#4a453e' },
  person: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  personText: { flex: 1, gap: 6 },
  name: { fontWeight: '700', fontSize: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }
});
