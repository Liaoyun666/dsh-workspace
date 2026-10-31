import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const M = 'E:\\Unity\\2019.4.15f1\\Editor\\Data\\Managed';
const MOD = path.join(M, 'UnityEngine');
const csc = 'E:\\Unity\\2019.4.15f1\\Editor\\Data\\Tools\\Roslyn\\csc.exe';
for (const p of [path.join(M,'UnityEngine.dll'), path.join(MOD,'UnityEngine.dll'), path.join(M,'UnityEditor.dll'), path.join(MOD,'UnityEditor.dll')]) {
  if (!fs.existsSync(p)) { console.log(p + ' MISSING'); continue; }
  const b = fs.readFileSync(p);
  console.log(p + ' size=' + b.length + ' md5=' + crypto.createHash('md5').update(b).digest('hex'));
}
const api = 'E:\\Unity\\2019.4.15f1\\Editor\\Data\\MonoBleedingEdge\\lib\\mono\\4.7.1-api\\';
const fw = ['mscorlib.dll','System.dll','System.Core.dll','System.Xml.dll'].map(f => api + f);
for (const f of fw) if (!fs.existsSync(f)) console.log('FW MISSING ' + f);
const dir = path.join(os.tmpdir(), 'refmatrix');
fs.mkdirSync(dir, { recursive: true });
const src = path.join(dir, 't.cs');
fs.writeFileSync(src, ['using System;','using UnityEngine;','using UnityEditor;','using UnityEditor.SceneManagement;','public static class T {','  public static object Run() {','    Material m = AssetDatabase.LoadAssetAtPath<Material>("Assets/x.mat");','    UnityEngine.SceneManagement.Scene s = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);','    GameObject go = new GameObject("x");','    BoxCollider bc = go.AddComponent<BoxCollider>();','    return go.name + m + s.name + bc.size;','  }','}',''].join('\n'));
const mods = fs.readdirSync(MOD).filter(f => f.endsWith('.dll')).map(f => path.join(MOD, f));
const modsNoDup = mods.filter(f => !/[\\/](UnityEngine|UnityEditor)\.dll$/i.test(f));
const sets = {
  S1_moddir_all: [...mods, path.join(M,'UnityEditor.dll')],
  S2_root_facade_plus_mods: [path.join(M,'UnityEngine.dll'), path.join(M,'UnityEditor.dll'), ...modsNoDup],
  S3_moddir_only: mods,
  S4_root_only: [path.join(M,'UnityEngine.dll'), path.join(M,'UnityEditor.dll')],
};
for (const [k, set] of Object.entries(sets)) {
  const out = path.join(dir, 'o_' + k + '.dll');
  try { fs.unlinkSync(out); } catch {}
  const args = ['/nologo','/target:library','/utf8output','/langversion:latest','/nowarn:0162,0168,0219,0414,0618','/out:' + out, ...set.map(r => '/r:' + r), ...fw.map(r => '/r:' + r), src];
  let outTxt = '', code = 0;
  try { outTxt = execFileSync(csc, args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }); }
  catch (e) { code = e.status; outTxt = (e.stdout || '') + (e.stderr || ''); }
  console.log('=== ' + k + ' refs=' + (set.length + fw.length) + ' exit=' + code);
  if (outTxt.trim()) console.log(outTxt.trim().split(/\r?\n/).slice(0, 6).join('\n'));
}
