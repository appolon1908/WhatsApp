import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function assertRegistry(text){
 const obj=JSON.parse(text);
 if(obj.schema!==1||!Array.isArray(obj.accounts)||!Array.isArray(obj.audit))
   throw new Error("invalid_registry_schema");
 if(obj.accounts.length>5000 || obj.audit.length>100000)throw new Error("registry_limits_exceeded");
 return {schema:obj.schema,accounts:obj.accounts.length,audit_entries:obj.audit.length};
}
async function durableDir(dir){
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const s=await fs.lstat(dir);
 if(!s.isDirectory()||s.isSymbolicLink())throw new Error("invalid_backup_directory");
 await fs.chmod(dir,0o700);
}
export async function backupPhoneRegistry(src,destination,{name}={}){
 const source=await fs.lstat(src);
 if(!source.isFile()||source.isSymbolicLink())throw new Error("invalid_source_file");
 await durableDir(destination);
 const stamp=(name||new Date().toISOString().replace(/[:.]/g,"-"));
 if(!/^[0-9A-Za-z_-]{6,80}$/.test(stamp))throw new Error("invalid_backup_name");
 const bytes=await fs.readFile(src);
 const metadata=assertRegistry(bytes.toString("utf8"));
 const checksum=crypto.createHash("sha256").update(bytes).digest("hex");
 const target=path.join(destination,"phone-accounts-"+stamp+".json");
 const descriptor=await fs.open(target,"wx",0o600);
 try{await descriptor.writeFile(bytes);await descriptor.sync();}finally{await descriptor.close();}
 await fs.writeFile(target+".sha256",checksum+"\n",{flag:"wx",mode:0o600});
 const checksumFile=await fs.open(target+".sha256","r+");
 try{await checksumFile.sync();}finally{await checksumFile.close();}
 const folder=await fs.open(destination,"r");
 try{await folder.sync();}finally{await folder.close();}
 return {file:target,checksum,metadata};
}
export async function verifyPhoneRegistryBackup(file){
 const source=await fs.lstat(file);
 if(!source.isFile()||source.isSymbolicLink())throw new Error("invalid_backup_file");
 const bytes=await fs.readFile(file),expected=(await fs.readFile(file+".sha256","utf8")).trim();
 const actual=crypto.createHash("sha256").update(bytes).digest("hex");
 if(!/^[a-f0-9]{64}$/.test(expected)||expected!==actual)throw new Error("backup_integrity_failed");
 return {valid:true,checksum:actual,metadata:assertRegistry(bytes.toString("utf8"))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 const [cmd,src,destination]=process.argv.slice(2);
 try{
  if(cmd==="backup"&&src&&destination){const result=await backupPhoneRegistry(src,destination);console.log(JSON.stringify({status:"BACKUP_CREATED",...result}));}
  else if(cmd==="verify"&&src){const result=await verifyPhoneRegistryBackup(src);console.log(JSON.stringify({status:"BACKUP_VERIFIED",...result}));}
  else throw new Error("usage: node scripts/phone-registry-backup.mjs backup <registry-file> <backup-dir> | verify <backup-file>");
 }catch(e){console.error("PHONE_BACKUP_ERROR:",e.message);process.exitCode=1;}
}
