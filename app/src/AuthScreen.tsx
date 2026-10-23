import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useCare } from './CareContext';
import { Button, Card, Field, T } from './ui';

export default function AuthScreen() {
  const { signIn } = useCare();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(path) {
    setStatus('');
    setBusy(true);
    try {
      await signIn(path, { name, email, password });
    } catch (error) {
      setStatus(error.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <T style={styles.title}>Your CareBell account</T>
      <T style={styles.hint}>Create an account on this server. The first account keeps the door history already stored here. This app is separate from the server: phones and the web page both sign in here.</T>
      <Field label="Your name" value={name} onChangeText={setName} autoComplete="name" />
      <Field label="Email" value={email} onChangeText={setEmail} autoComplete="username" keyboardType="email-address" autoCapitalize="none" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" />
      <View style={styles.row}>
        <Button label="Create account" tone="primary" disabled={busy} onPress={() => submit('/api/register')} />
        <Button label="Sign in" disabled={busy} onPress={() => submit('/api/login')} />
      </View>
      <T accessibilityLiveRegion="polite">{status}</T>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: '700' },
  hint: { color: '#4a453e' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }
});
