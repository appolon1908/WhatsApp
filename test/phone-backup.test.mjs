import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {backupPhoneRegistry,verifyPhoneRegistryBackup} from "../scripts/phone-registry-backup.mjs";

test("backups preserve sealed registry and report platform durability and permissions",async()=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),"wa-registry-backup-"));
 try{
  const file=path.join(d,"source.json"),destination=path.join(d,"backups");
  const data={schema:1,accounts:[{tenant_id:"TENANTQA",number:"+18095550000",provider:"meta"}],audit:[]};
  await fs.writeFile(file,JSON.stringify(data));
  const backup=await backupPhoneRegistry(file,destination,{name:"test-20261008"});
  assert.equal(backup.metadata.accounts,1);
  assert.equal(backup.directory_synced,process.platform!=="win32");
  assert.equal(backup.permission_model,process.platform==="win32"?"windows-acl":"posix-mode");
  if(process.platform!=="win32"){
   assert.equal((await fs.stat(backup.file)).mode&0o777,0o600);
   assert.equal((await fs.stat(destination)).mode&0o777,0o700);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(backup.file,"utf8")),data);
  assert.equal((await verifyPhoneRegistryBackup(backup.file)).valid,true);
  await assert.rejects(backupPhoneRegistry(file,destination,{name:"test-20261008"}),e=>e.code==="EEXIST");
  await fs.appendFile(backup.file,"tamper");
  await assert.rejects(verifyPhoneRegistryBackup(backup.file),/backup_integrity_failed/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test("file fsync failure prevents a successful backup response",async(t)=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),"wa-backup-sync-error-"));
 t.after(()=>fs.rm(d,{recursive:true,force:true}));
 const file=path.join(d,"source.json");
 await fs.writeFile(file,JSON.stringify({schema:1,accounts:[],audit:[]}));
 const open=fs.open.bind(fs);
 t.mock.method(fs,"open",async(...args)=>{
  const handle=await open(...args);
  if(args[1]==="wx")handle.sync=async()=>{throw Object.assign(new Error("disk write failed"),{code:"EIO"});};
  return handle;
 });
 await assert.rejects(backupPhoneRegistry(file,path.join(d,"backups"),{name:"sync-error"}),e=>e.code==="EIO");
});
test("backups refuse malformed and unsupported source format",async()=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),"wa-registry-backup-invalid-"));
 try{
  const file=path.join(d,"source.json");
  await fs.writeFile(file,'{"unexpected":true}');
  await assert.rejects(backupPhoneRegistry(file,path.join(d,"backups"),{name:"qa-broken"}),/invalid_registry_schema/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});
