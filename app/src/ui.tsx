import { Image, Pressable, StyleSheet, Text, TextInput, View, type ImageStyle, type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import { mediaUrl } from './api';
import { useCare } from './CareContext';

export const colors = {
  bg: '#f3eee4',
  ink: '#1c1915',
  muted: '#4a453e',
  card: '#fffdf8',
  line: '#ddd4c6',
  brand: '#9a3412'
};

export function T({ style, ...rest }: TextProps) {
  const { fontSize } = useCare();
  return <Text style={[{ fontSize, color: colors.ink, lineHeight: Math.round(fontSize * 1.4) }, style]} {...rest} />;
}

export function Button({ label, onPress, tone = 'plain', disabled }: { label: string; onPress?: () => void; tone?: 'plain' | 'primary' | 'danger'; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, tone === 'primary' && styles.primary, tone === 'danger' && styles.danger, disabled && styles.disabled]}
    >
      <Text style={[styles.buttonText, (tone === 'primary' || tone === 'danger') && styles.buttonTextLight]}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, value, onChangeText, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <T style={styles.label}>{label}</T>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        style={styles.input}
        placeholderTextColor={colors.muted}
        {...rest}
      />
    </View>
  );
}

export function Card({ children }: { children?: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Photo({ path, token, style }: { path?: string; token?: string; style?: StyleProp<ImageStyle> }) {
  if (!path) return null;
  return (
    <Image
      accessibilityIgnoresInvertColors
      style={[styles.photo, style]}
      source={{ uri: mediaUrl(path), headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
    />
  );
}

export function Choice({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceOn]}
    >
      <Text style={[styles.choiceText, selected && styles.choiceTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primary: { backgroundColor: colors.brand, borderColor: colors.brand },
  danger: { backgroundColor: '#7a1d1d', borderColor: '#7a1d1d' },
  disabled: { opacity: 0.55 },
  buttonText: { color: colors.ink, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  buttonTextLight: { color: '#fffdf8' },
  field: { gap: 6 },
  label: { fontWeight: '700' },
  input: {
    minHeight: 48,
    borderWidth: 2,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    color: colors.ink,
    fontSize: 18
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 10
  },
  photo: { width: 120, height: 90, borderRadius: 10, backgroundColor: '#ddd4c6' },
  choice: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.line,
    backgroundColor: colors.card
  },
  choiceOn: { borderColor: colors.brand, backgroundColor: '#fff1e6' },
  choiceText: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  choiceTextOn: { color: colors.brand }
});
