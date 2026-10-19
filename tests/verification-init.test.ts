import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

const initializer = pathToFileURL(path.resolve("examples/agent-verification/init.mjs")).href;
const {initializeVerification} = await import(initializer);
let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "testlane-authoring-init-"));
  await fs.writeFile(path.join(root, "feature.txt"), "A reader can view a saved item but cannot edit it. Verify persistence and cleanup.\n");
});
afterEach(async () => {await fs.rm(root, {recursive:true, force:true});});
const input = () => ({cwd:root, brief:"feature.txt", target:"http://localhost:4017", profile:"sample:testing:reader", outputDir:"e2e/checks"});

describe("verification authoring scaffold", () => {
  it("preserves the brief and starts with an unrunnable draft rather than invented passing tests", async () => {
    await initializeVerification(input());
    const directory=path.join(root,"e2e/checks");
    expect(await fs.readFile(path.join(directory,"brief.md"),"utf8")).toBe(await fs.readFile(path.join(root,"feature.txt"),"utf8"));
    const plan=JSON.parse(await fs.readFile(path.join(directory,"plan.json"),"utf8"));
    expect(plan.status).toBe("draft");
    expect(plan.target.baseUrl).toBe("http://localhost:4017");
    expect(await fs.readFile(path.join(directory,"feature.spec.mjs"),"utf8")).toContain("test.skip(");
    expect(await fs.readFile(path.join(directory,".gitignore"),"utf8")).toContain("brief.md");
  });
  it("refuses to replace an existing suite and leaves every existing file intact", async () => {
    await initializeVerification(input());
    const dir=path.join(root,"e2e/checks");
    const names=await fs.readdir(dir);
    const before=await Promise.all(names.map(name=>fs.readFile(path.join(dir,name))));
    await expect(initializeVerification(input())).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(names);
    const after=await Promise.all(names.map(name=>fs.readFile(path.join(dir,name))));
    expect(after).toEqual(before);
  });
  it.each(["https://production.example.test", "http://sandbox.example.test", "https://example.test/path", "https://user:pass@example.test", "http://localhost:4017/?key=value"])("refuses an unsuitable target before writing: %s", async target => {
    await expect(initializeVerification({...input(),target})).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(["feature.txt"]);
  });
  it("rejects traversal out of the consuming project before creating directories", async () => {
    await expect(initializeVerification({...input(),outputDir:"../outside/suite"})).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(["feature.txt"]);
  });
  it.each(["Sample:testing:reader", "sample::reader", "sample:testing:"])("refuses a profile the broker cannot use before writing: %s", async profile => {
    await expect(initializeVerification({...input(),profile})).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(["feature.txt"]);
  });
  it("refuses a junction/symlink ancestor leading outside the consuming project", async () => {
    const outside=await fs.mkdtemp(path.join(os.tmpdir(),"testlane-authoring-outside-"));
    try {
      await fs.symlink(outside,path.join(root,"external"),process.platform==="win32"?"junction":"dir");
      await expect(initializeVerification({...input(),outputDir:"external/new/suite"})).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {await fs.rm(outside,{recursive:true,force:true});}
  });
  it("refuses malformed UTF-8 instead of silently changing a requirement", async () => {
    await fs.writeFile(path.join(root,"feature.txt"),Buffer.from([0xff,0xfe]));
    await expect(initializeVerification(input())).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(["feature.txt"]);
  });
});
