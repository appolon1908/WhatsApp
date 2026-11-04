import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncDirectory } from "../src/storage-durability.mjs";

test("POSIX directory flush is awaited and failures propagate after closing the handle",async(t)=>{
 const original=Object.getOwnPropertyDescriptor(process,"platform");
 Object.defineProperty(process,"platform",{...original,value:"linux"});
 t.after(()=>Object.defineProperty(process,"platform",original));
 for(const error of [null,Object.assign(new Error("directory flush denied"),{code:"EPERM"}),Object.assign(new Error("disk failure"),{code:"EIO"})]){
  const events=[];
  t.mock.method(fs,"open",async(directory,mode)=>{
   assert.equal(directory,"registry-directory");assert.equal(mode,"r");
   return {async sync(){events.push("sync");if(error)throw error;},async close(){events.push("close");}};
  });
  if(error)await assert.rejects(syncDirectory("registry-directory"),e=>e===error);
  else assert.equal(await syncDirectory("registry-directory"),true);
  assert.deepEqual(events,["sync","close"]);
  t.mock.restoreAll();
 }
});

test("POSIX directory-open failure is not treated as unsupported directory flushing",async(t)=>{
 const original=Object.getOwnPropertyDescriptor(process,"platform");
 Object.defineProperty(process,"platform",{...original,value:"linux"});
 t.after(()=>Object.defineProperty(process,"platform",original));
 const error=Object.assign(new Error("directory inaccessible"),{code:"EACCES"});
 t.mock.method(fs,"open",async()=>{throw error;});
 await assert.rejects(syncDirectory("registry-directory"),e=>e===error);
});
