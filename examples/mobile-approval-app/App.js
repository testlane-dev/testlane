import React, { useRef, useState } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { consumeBootstrap } from './bootstrap.mjs';

function Value({ id, children }) { return <Text accessible testID={id} accessibilityLabel={id} accessibilityValue={Platform.OS === 'ios' ? { text: String(children ?? '-') } : undefined} style={styles.value}>{String(children ?? '-')}</Text>; }
function Action({ id, title, onPress, disabled }) { return <Pressable testID={id} accessibilityLabel={id} accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{title}</Text></Pressable>; }
const KEYBOARD_ACCESSORY_ID = 'proof-keyboard-accessory';
function Input({ id, value, onChangeText, label, numeric }) { return <View style={styles.inputBox}><Text style={styles.label}>{label}</Text><TextInput testID={id} accessibilityLabel={id} value={value} onChangeText={onChangeText} keyboardType={numeric ? 'number-pad' : 'default'} inputAccessoryViewID={Platform.OS === 'ios' ? KEYBOARD_ACCESSORY_ID : undefined} autoCapitalize="none" autoCorrect={false} style={styles.input}/></View>; }
function Field({ name, value }) { return <View style={styles.field}><Text style={styles.label}>{name}</Text><Value id={'request-' + name}>{value}</Value></View>; }

export default function App() {
  const [connection, setConnection] = useState(null), connectionRef = useRef(null);
  const [identity, setIdentity] = useState(null), [sessionStatus, setSessionStatus] = useState('signed-out');
  const [apiStatus, setApiStatus] = useState('0'), [operation, setOperation] = useState('IDLE'), [busy, setBusy] = useState(false);
  const [marker, setMarker] = useState(''), [quantity, setQuantity] = useState('3'), [price, setPrice] = useState('1400');
  const [selected, setSelected] = useState(''), [record, setRecord] = useState(null);
  const setSession = value => { connectionRef.current = value; setConnection(value); };
  async function api(route, { method = 'GET', data, anonymous = false, session = connectionRef.current } = {}) {
    if (!session?.origin) throw Error('SESSION_REQUIRED');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(session.origin + route, { method, signal: controller.signal, credentials: 'omit',
        headers: { ...(anonymous || !session.cookie ? {} : { Cookie: session.cookie }), ...(data ? { 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}) });
      setApiStatus(String(response.status));
      let body = null;
      if (response.ok && response.status !== 204) body = await response.json();
      return { status: response.status, body };
    } finally { clearTimeout(timer); }
  }
  async function perform(work) {
    if (busy) return; setBusy(true); setOperation('WORKING');
    try { await work(); }
    catch (error) { setApiStatus('0'); setOperation(['BOOTSTRAP_INVALID', 'BOOTSTRAP_READ_FAILED', 'BOOTSTRAP_DELETE_FAILED', 'SESSION_REQUIRED'].includes(error?.message) ? error.message : 'OPERATION_FAILED'); }
    finally { setBusy(false); }
  }
  async function loadSession() {
    return perform(async () => {
      setIdentity(null); setRecord(null); setSelected(''); setSession(null); setSessionStatus('loading');
      try {
        const file = new File(Paths.document, 'testlane-bootstrap.json');
        const next = consumeBootstrap({ read: () => { if (!file.exists || file.size > 4096) throw Error(); return file.textSync(); }, remove: () => { if (file.exists) file.delete(); } });
        const result = await api('/api/me', { session: next });
        if (result.status !== 200 || !result.body || !['Editor', 'Reviewer'].includes(result.body.role) || typeof result.body.email !== 'string') {
          setSession({ origin: next.origin, cookie: null }); setSessionStatus('SESSION_REJECTED'); setOperation('SESSION_REJECTED'); return;
        }
        setSession(next); setIdentity({ email: result.body.email, role: result.body.role }); setSessionStatus('ready'); setOperation('SESSION_READY');
      } catch (error) { setSessionStatus('SESSION_LOAD_FAILED'); throw error; }
    });
  }
  function signOut() { setSession(connectionRef.current ? { origin: connectionRef.current.origin, cookie: null } : null); setIdentity(null); setRecord(null); setSelected(''); setSessionStatus('signed-out'); setApiStatus('0'); setOperation('SIGNED_OUT'); }
  async function loadRequest() {
    return perform(async () => {
      if (selected && !/^[a-f0-9-]{36}$/.test(selected)) throw Error('REQUEST_INVALID');
      const result = await api(selected ? '/api/requests/' + selected : '/api/requests');
      if (result.status === 200) { const row = Array.isArray(result.body) ? result.body.at(-1) ?? null : result.body; setRecord(row); if (row) setSelected(row.id); }
      setOperation('HTTP_' + result.status);
    });
  }
  return <><ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.heading}>Approval sandbox</Text><Text style={styles.subtitle}>Synthetic {Platform.OS === 'ios' ? 'iOS Simulator' : 'Android'} proof · local generated accounts only</Text>
    <View style={styles.row}><Action id="load-session" title="Load sandbox session" onPress={loadSession} disabled={busy}/><Action id="sign-out" title="Sign out" onPress={signOut} disabled={busy}/></View>
    <View style={styles.row}><Value id="identity-email">{identity?.email}</Value><Value id="identity-role">{identity?.role}</Value></View>
    <View style={styles.row}><Value id="session-status">{sessionStatus}</Value><Value id="api-status">{apiStatus}</Value><Value id="operation-status">{operation}</Value></View>
    <Input id="run-marker" label="Run marker" value={marker} onChangeText={setMarker}/>
    <View style={styles.row}><Input id="quantity" label="Quantity" value={quantity} onChangeText={setQuantity} numeric/><Input id="unit-price" label="Unit price (cents)" value={price} onChangeText={setPrice} numeric/>
      <Action id="create-request" title="Create" disabled={busy} onPress={() => perform(async () => {
        const result = await api('/api/requests', { method: 'POST', data: { marker, quantity: Number(quantity), unitPriceCents: Number(price) } });
        if (result.status === 201) { setRecord(result.body); setSelected(result.body.id); } setOperation('HTTP_' + result.status);
      })}/></View>
    <Input id="selected-id" label="Selected request ID" value={selected} onChangeText={setSelected}/>
    <View style={styles.row}><Action id="load-request" title="Load request" disabled={busy} onPress={loadRequest}/><Action id="refresh-request" title="Refresh" disabled={busy} onPress={loadRequest}/>
      <Action id="approve-request" title="Approve" disabled={busy} onPress={() => perform(async () => {
        if (!/^[a-f0-9-]{36}$/.test(selected)) throw Error('REQUEST_INVALID');
        const result = await api('/api/requests/' + selected + '/approve', { method: 'POST' });
        if (result.status === 200) setRecord(result.body); setOperation('HTTP_' + result.status);
      })}/></View>
    <View style={styles.fields}><Field name="id" value={record?.id}/><Field name="total" value={record?.totalCents}/><Field name="status" value={record?.status}/><Field name="version" value={record?.version}/><Field name="owner" value={record?.ownerEmail}/><Field name="approver" value={record?.approverEmail}/><Field name="quantity" value={record?.quantity}/><Field name="unit-price" value={record?.unitPriceCents}/><Field name="marker" value={record?.marker}/></View>
    <Action id="anonymous-check" title="Check anonymous access" disabled={busy || !connection?.origin} onPress={() => perform(async () => {
      const result = await api('/api/requests', { anonymous: true }); setOperation('ANONYMOUS_HTTP_' + result.status);
    })}/>
  </ScrollView>
    {Platform.OS === 'ios' && <InputAccessoryView nativeID={KEYBOARD_ACCESSORY_ID}>
      <View style={styles.accessory}><Action id="dismiss-keyboard" title="Done" onPress={Keyboard.dismiss}/></View>
    </InputAccessoryView>}
  </>;
}
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#eef3fa' }, content: { padding: 16, paddingTop: 40, paddingBottom: 40, gap: 8 },
  heading: { fontSize: 23, fontWeight: '700', color: '#142b4a' }, subtitle: { fontSize: 11, color: '#465b75' }, row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  button: { backgroundColor: '#235ba8', borderRadius: 6, minHeight: 42, justifyContent: 'center', paddingHorizontal: 12 }, buttonText: { color: 'white', fontSize: 12, fontWeight: '600' }, disabled: { opacity: 0.45 },
  label: { fontSize: 10, color: '#44536a' }, value: { fontSize: 11, color: '#142b4a', paddingVertical: 2 }, inputBox: { flexGrow: 1, minWidth: 80 },
  input: { borderWidth: 1, borderColor: '#a9b9d0', backgroundColor: 'white', minHeight: 40, paddingHorizontal: 8, borderRadius: 5, fontSize: 12 }, accessory: { flexDirection: 'row', justifyContent: 'flex-end', padding: 8, backgroundColor: '#eef3fa' }, fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, field: { width: '47%', borderBottomWidth: 1, borderBottomColor: '#d2dcea', paddingVertical: 3 } });
