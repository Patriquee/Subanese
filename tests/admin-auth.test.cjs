const {test} = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {scryptSync} = require('node:crypto');
const {createAdminAuth} = require('../admin-auth.cjs');
test('inline browser scripts compile with login and recovery forms',()=>{
  const fs = require('node:fs'), vm = require('node:vm');
  const source=fs.readFileSync(require.resolve('../server.cjs'),'utf8');
  const html=source.slice(source.indexOf('const HTML = String.raw`')+'const HTML = String.raw`'.length,source.lastIndexOf('`')).replace('${JSON.stringify(cakeCatalog)}','[]');
  let count=0;
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) { new vm.Script(match[1]); count++; }
  assert.ok(count>=2);
  assert.ok(html.includes('admin-credentials-form'));
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE admin (salt TEXT,password TEXT); INSERT INTO admin VALUES ('salt','old'); CREATE TABLE sessions (token TEXT,expires INTEGER); INSERT INTO sessions VALUES ('session',9999999999999)");
  let clock = 1000, mail;
  const auth = createAdminAuth(db,{env:{ADMIN_USERNAME:'baker',ADMIN_EMAIL:'admin@example.com',RESEND_API_KEY:'test',EMAIL_FROM:'bakery@example.com',PUBLIC_SITE_URL:'https://shop.example.com'},now:()=>clock,fetchImpl:async (_,options)=>{mail=JSON.parse(options.body);return {ok:true};}});
  return {db,auth,get mail(){return mail;},advance:()=>clock+=900001};
}
test('reset requires emailed link and code, changes password once and revokes sessions',async()=>{
  const f=fixture();
  await f.auth.requestReset('admin@example.com','ip');
  const token=/reset=([a-f0-9]+)/.exec(f.mail.text)[1],code=/code: (\d{6})/.exec(f.mail.text)[1];
  assert.throws(()=>f.auth.reset({token,code:'000000',password:'a new password 123'},'ip'),/invalid/);
  assert.throws(()=>f.auth.reset({token:'wrong',code,password:'a new password 123'},'ip'),/invalid/);
  f.auth.reset({token,code,password:'a new password 123'},'ip');
  const admin=f.db.prepare('SELECT * FROM admin').get();
  assert.equal(admin.password,scryptSync('a new password 123',admin.salt,64).toString('hex'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  assert.throws(()=>f.auth.reset({token,code,password:'another password 123'},'ip'),/invalid/);
  f.db.close();
});
test('unknown emails do not send and new requests invalidate prior links; expiry and code attempt limits apply',async()=>{
  const f=fixture();
  await f.auth.requestReset('unknown@example.com','ip'); assert.equal(f.mail,undefined);
  await f.auth.requestReset('admin@example.com','ip');
  const token=/reset=([a-f0-9]+)/.exec(f.mail.text)[1];
  for(let i=0;i<5;i++) assert.throws(()=>f.auth.reset({token,code:'000000',password:'long enough password'},'ip'),/invalid/);
  const code=/code: (\d{6})/.exec(f.mail.text)[1];
  assert.throws(()=>f.auth.reset({token,code,password:'long enough password'},'other'),/invalid/);
  await f.auth.requestReset('admin@example.com','ip');
  assert.throws(()=>f.auth.reset({token,code,password:'long enough password'},'other'),/invalid/);
  const newer=/reset=([a-f0-9]+)/.exec(f.mail.text)[1],newCode=/code: (\d{6})/.exec(f.mail.text)[1];
  f.advance(); assert.throws(()=>f.auth.reset({token:newer,code:newCode,password:'long enough password'},'other'),/expired/);
  f.db.close();
});
test('separate code verification authorizes new password and the grant works once',async()=>{
  const f=fixture();
  const token=await f.auth.requestReset('admin@example.com','ip');
  const code=/code: (\d{6})/.exec(f.mail.text)[1];
  for(let i=0;i<4;i++) assert.throws(()=>f.auth.verifyCode({token,code:'000000'},'ip'),/invalid/);
  const grant=f.auth.verifyCode({token,code},'ip');
  assert.throws(()=>f.auth.verifyCode({token,code},'ip'),/invalid/);
  assert.throws(()=>f.auth.reset({grant:'invalid',password:'new secure password'},'ip'),/invalid/);
  f.auth.reset({grant,password:'new secure password'},'ip');
  assert.throws(()=>f.auth.reset({grant,password:'new secure password'},'ip'),/invalid/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  f.db.close();
});
