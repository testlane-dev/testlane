import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {Writable} from "node:stream";
import {afterEach,beforeEach,expect,it} from "vitest";
import {runVerification} from "../src/verification.js";
class Capture extends Writable {
  text="";
  override _write(chunk:unknown,_encoding:BufferEncoding,done:()=>void):void{this.text+=String(chunk);done();}
}
let root="";
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"testlane-verify-command-"));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it("initializes paths with spaces and preserves a draft refusal through the real CLI adapter",async()=>{
  await fs.writeFile(path.join(root,"feature brief.txt"),"A reader cannot approve a request.\n");
  const initOut=new Capture(),initErr=new Capture();
  expect(await runVerification({mode:"init",cwd:root,stdout:initOut,stderr:initErr,brief:"feature brief.txt",target:"http://localhost:4555",profile:"sample:testing:reader",outputDir:"e2e/feature suite",json:true})).toBe(0);
  expect(JSON.parse(initOut.text).status).toBe("draft");
  const runOut=new Capture(),runErr=new Capture();
  expect(await runVerification({mode:"run",cwd:root,stdout:runOut,stderr:runErr,plan:"e2e/feature suite/plan.json",outputDir:"private evidence",json:true})).toBe(2);
  const report=JSON.parse(runOut.text);
  expect(report.verdict).toBe("blocked");
  expect(report.reasonCodes).toContain("PLAN_NOT_REVIEWED");
  expect(initErr.text+runErr.text).toBe("");
});
it("delivers cancellation queued before child readiness and leaves no signal listeners",async()=>{
  const plan={schemaVersion:1,status:"reviewed",title:"Check a generated sandbox",target:{baseUrl:"http://localhost:4555",environment:"testing"},cases:[{id:"check-request",title:"A request is visible",spec:"request.spec.mjs",expected:["The request is visible"],cleanup:{required:false,description:"No app data is changed"}}]};
  await fs.writeFile(path.join(root,"plan.json"),JSON.stringify(plan));
  const before=[process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")];
  const stdout=new Capture(),stderr=new Capture();
  const running=runVerification({mode:"run",cwd:root,stdout,stderr,plan:"plan.json",outputDir:"private evidence",json:true});
  process.emit("SIGINT");
  expect(await running).not.toBe(0);
  expect(JSON.parse(stdout.text).verdict).toBe("cancelled");
  expect([process.listenerCount("SIGINT"),process.listenerCount("SIGTERM")]).toEqual(before);
  expect(stderr.text).toContain("waiting for cleanup");
});
it("initializes the real CLI adapter from an aliased cwd with absolute output resolution",async()=>{
  const container=await fs.mkdtemp(path.join(os.tmpdir(),"testlane-verify-command-alias-"));
  const alias=path.join(container,"app");
  try{
    await fs.writeFile(path.join(root,"feature brief.txt"),"A note persists after reload.\n");
    await fs.symlink(root,alias,process.platform==="win32"?"junction":"dir");
    const stdout=new Capture(),stderr=new Capture();
    expect(await runVerification({mode:"init",cwd:alias,stdout,stderr,brief:"feature brief.txt",target:"http://localhost:4555",profile:"sample:testing:qa",outputDir:"e2e/aliased suite",json:true})).toBe(0);
    expect(JSON.parse(stdout.text).directory).toBe("e2e/aliased suite");
    expect(stderr.text).toBe("");
    expect(await fs.readFile(path.join(root,"e2e","aliased suite","brief.md"),"utf8")).toBe("A note persists after reload.\n");
  }finally{await fs.rm(container,{recursive:true,force:true});}
});
