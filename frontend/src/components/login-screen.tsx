import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedView } from '@/components/themed-view';
import { Colors, FontSize, Glass, Radius, Spacing } from '@/constants/theme';
import { useAuthStore } from '@/stores/auth-store';

const HAIRLINE_LIGHT = 'rgba(0,0,0,0.10)';
const HAIRLINE_DARK = 'rgba(255,255,255,0.12)';

export function LoginScreen() {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login, register } = useAuthStore();

  const rawScheme = useColorScheme();
  const scheme = rawScheme === 'dark' ? 'dark' : 'light';
  const colors = Colors[scheme];
  const glass = Glass[scheme];
  const hairline = scheme === 'dark' ? HAIRLINE_DARK : HAIRLINE_LIGHT;

  const submit = async () => {
    if (!account.trim() || !password.trim()) {
      setError('请填写账号和密码');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(account.trim(), password);
      } else {
        await register(account.trim(), password);
      }
    } catch (e: unknown) {
      const err = e as { code?: string; status?: number; message?: string };
      if (err.code === 'account_taken') setError('账号已被占用');
      else if (err.status === 401) setError('账号或密码有误');
      else setError(err.message ?? '网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      {/* Decorative accent glow */}
      <View
        style={[styles.glowBlob, { backgroundColor: glass.tint }]}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.kav}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>

            {/* ── Branding ── */}
            <View style={styles.branding}>
              <View style={[styles.appIcon, { backgroundColor: glass.tint, shadowColor: glass.tint }]}>
                <Text style={styles.appIconChar}>减</Text>
              </View>
              <Text style={[styles.appName, { color: colors.text }]}>减脂记录</Text>
              <Text style={[styles.tagline, { color: colors.textSecondary }]}>
                {'用一句话记录吃了什么，\nAI 帮你算热量、盯住每日缺口'}
              </Text>
            </View>

            {/* ── Form ── */}
            <View style={styles.form}>
              {/* Segmented toggle */}
              <View style={[styles.toggle, { backgroundColor: colors.backgroundElement }]}>
                {(['register', 'login'] as const).map((m) => {
                  const active = mode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      style={[
                        styles.toggleBtn,
                        active && [styles.toggleBtnActive, { backgroundColor: colors.background }],
                      ]}
                      onPress={() => { setMode(m); setError(null); }}
                      activeOpacity={0.7}>
                      <Text
                        style={[
                          styles.toggleText,
                          { color: active ? colors.text : colors.textSecondary },
                          active && styles.toggleTextActive,
                        ]}>
                        {m === 'register' ? '注册' : '登录'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Username */}
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>用户名</Text>
                <View
                  style={[
                    styles.fieldRow,
                    {
                      backgroundColor: colors.backgroundElement,
                      borderColor: account.length > 0 ? glass.tint : hairline,
                      borderWidth: account.length > 0 ? 1.5 : 0.5,
                    },
                  ]}>
                  <SymbolView
                    name={{ ios: 'at', android: 'alternate_email', web: 'alternate_email' }}
                    size={18}
                    tintColor={colors.textSecondary}
                    style={styles.fieldIconView}
                  />
                  <TextInput
                    style={[styles.fieldInput, { color: colors.text }]}
                    placeholder="输入用户名"
                    placeholderTextColor={colors.textSecondary}
                    value={account}
                    onChangeText={setAccount}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                  {account.length > 0 && (
                    <SymbolView
                      name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                      size={18}
                      tintColor="#34C759"
                      style={styles.fieldIconView}
                    />
                  )}
                </View>
              </View>

              {/* Password */}
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>密码</Text>
                <View
                  style={[
                    styles.fieldRow,
                    {
                      backgroundColor: colors.backgroundElement,
                      borderColor: password.length > 0 ? glass.tint : hairline,
                      borderWidth: password.length > 0 ? 1.5 : 0.5,
                    },
                  ]}>
                  <SymbolView
                    name={{ ios: 'lock', android: 'lock', web: 'lock' }}
                    size={18}
                    tintColor={colors.textSecondary}
                    style={styles.fieldIconView}
                  />
                  <TextInput
                    style={[styles.fieldInput, { color: colors.text }]}
                    placeholder="输入密码"
                    placeholderTextColor={colors.textSecondary}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPw}
                    returnKeyType="done"
                    onSubmitEditing={submit}
                  />
                  <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={8}>
                    <SymbolView
                      name={
                        showPw
                          ? { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' }
                          : { ios: 'eye', android: 'visibility', web: 'visibility' }
                      }
                      size={18}
                      tintColor={colors.textSecondary}
                      style={styles.fieldIconView}
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Error */}
              {error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : null}

              {/* Submit */}
              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  { backgroundColor: glass.tint, shadowColor: glass.tint },
                ]}
                onPress={submit}
                disabled={loading}
                activeOpacity={0.85}>
                {loading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitText}>
                    {mode === 'register' ? '创建账号' : '登录'}
                  </Text>
                )}
                {!loading && (
                  <SymbolView
                    name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                    size={17}
                    tintColor="#fff"
                    style={styles.submitArrow}
                  />
                )}
              </TouchableOpacity>

              {/* Switch mode link */}
              <TouchableOpacity
                onPress={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(null); }}
                style={styles.switchRow}
                activeOpacity={0.7}>
                <Text style={[styles.switchText, { color: colors.textSecondary }]}>
                  {mode === 'register' ? '已有账号？' : '没有账号？'}
                  <Text style={[styles.switchAccent, { color: glass.tint }]}>
                    {mode === 'register' ? '去登录' : '去注册'}
                  </Text>
                </Text>
              </TouchableOpacity>
            </View>

          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  safe: { flex: 1 },
  kav: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingBottom: 44,
  },

  // Decorative glow
  glowBlob: {
    position: 'absolute',
    top: -60,
    right: -40,
    width: 260,
    height: 260,
    borderRadius: 130,
    opacity: 0.15,
  },

  // Branding
  branding: {
    alignItems: 'center',
    paddingTop: Spacing.six,
    paddingBottom: Spacing.four,
    gap: Spacing.two,
  },
  appIcon: {
    width: 84,
    height: 84,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.two,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.42,
    shadowRadius: 20,
    elevation: 10,
  },
  appIconChar: {
    fontSize: 36,
    fontWeight: '800',
    color: '#fff',
  },
  appName: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  tagline: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    marginTop: Spacing.one,
  },

  // Form
  form: {
    gap: 12,
  },

  // Toggle
  toggle: {
    flexDirection: 'row',
    borderRadius: 14,
    padding: 3,
    gap: 3,
    marginBottom: Spacing.two,
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    borderRadius: 11,
  },
  toggleBtnActive: {
    shadowColor: 'rgba(0,0,0,0.12)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 6,
    elevation: 2,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: '500',
  },
  toggleTextActive: {
    fontWeight: '600',
  },

  // Fields
  fieldGroup: {
    gap: 7,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 4,
  },
  fieldRow: {
    height: 52,
    borderRadius: 15,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    gap: 10,
  },
  fieldIconView: {
    width: 20,
    height: 20,
  },
  fieldInput: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },

  // Error
  errorText: {
    fontSize: FontSize.sm,
    color: '#FF3B30',
    marginLeft: 4,
  },

  // Submit
  submitBtn: {
    height: 54,
    borderRadius: 27,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.42,
    shadowRadius: 28,
    elevation: 8,
  },
  submitText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
  },
  submitArrow: {
    width: 17,
    height: 17,
  },

  // Switch mode
  switchRow: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  switchText: {
    fontSize: 13.5,
  },
  switchAccent: {
    fontWeight: '600',
  },
});
