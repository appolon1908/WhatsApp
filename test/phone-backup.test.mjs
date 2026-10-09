import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {backupPhoneRegistry,verifyPhoneRegistryBackup} from "../scripts/phone-registry-backup.mjs";

test("backups preserve sealed registry with checksum and restrictive permissions",async()=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),"wa-registry-backup-"));
 try{
  const file=path.join(d,"source.json"),destination=path.join(d,"backups");
  const data={schema:1,accounts:[{tenant_id:"TENANTQA",number:"+18095550000",provider:"meta"}],audit:[]};
  await fs.writeFile(file,JSON.stringify(data));
  const backup=await backupPhoneRegistry(file,destination,{name:"test-20261008"});
  assert.equal(backup.metadata.accounts,1);
  assert.equal((await fs.stat(backup.file)).mode&0o777,0o600);
  assert.equal((await fs.stat(destination)).mode&0o777,0o700);
  assert.equal((await verifyPhoneRegistryBackup(backup.file)).valid,true);
  await assert.rejects(backupPhoneRegistry(file,destination,{name:"test-20261008"}),e=>e.code==="EEXIST");
  await fs.appendFile(backup.file,"tamper");
  await assert.rejects(verifyPhoneRegistryBackup(backup.file),/backup_integrity_failed/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});
test("backups refuse malformed and unsupported source format",async()=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),"wa-registry-backup-invalid-"));
 try{
  const file=path.join(d,"source.json");
  await fs.writeFile(file,'{"unexpected":true}');
  await assert.rejects(backupPhoneRegistry(file,path.join(d,"backups"),{name:"qa-broken"}),/invalid_registry_schema/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});
