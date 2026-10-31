$M = 'E:\Unity\2019.4.15f1\Editor\Data\Managed'
$MOD = Join-Path $M 'UnityEngine'
$csc = 'E:\Unity\2019.4.15f1\Editor\Data\Tools\Roslyn\csc.exe'
foreach ($p in @((Join-Path $M 'UnityEngine.dll'), (Join-Path $MOD 'UnityEngine.dll'), (Join-Path $M 'UnityEditor.dll'), (Join-Path $MOD 'UnityEditor.dll'))) { if (Test-Path $p) { $f = Get-Item $p; $h = (Get-FileHash $p -Algorithm MD5).Hash; "$p size=$($f.Length) md5=$h" } else { "$p MISSING" } }
$fw = @('E:\Unity\2019.4.15f1\Editor\Data\MonoBleedingEdge\lib\mono\4.7.1-api\mscorlib.dll','E:\Unity\2019.4.15f1\Editor\Data\MonoBleedingEdge\lib\mono\4.7.1-api\System.dll','E:\Unity\2019.4.15f1\Editor\Data\MonoBleedingEdge\lib\mono\4.7.1-api\System.Core.dll','E:\Unity\2019.4.15f1\Editor\Data\MonoBleedingEdge\lib\mono\4.7.1-api\System.Xml.dll')
foreach ($x in $fw) { if (-not (Test-Path $x)) { "FW MISSING $x" } }
$dir = Join-Path $env:TEMP 'refmatrix'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$src = Join-Path $dir 't.cs'
$srcText = @'
using System;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
public static class T {
  public static object Run() {
    Material m = AssetDatabase.LoadAssetAtPath<Material>("Assets/x.mat");
    UnityEngine.SceneManagement.Scene s = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    GameObject go = new GameObject("x");
    BoxCollider bc = go.AddComponent<BoxCollider>();
    return go.name + m + s.name + bc.size;
  }
}
'@
Set-Content -Path $src -Value $srcText -Encoding UTF8
$NL = [string][char]10
$mods = @(Get-ChildItem $MOD -Filter *.dll | ForEach-Object FullName)
$modsNoDup = @(Get-ChildItem $MOD -Filter *.dll | Where-Object { $_.Name -ne 'UnityEngine.dll' -and $_.Name -ne 'UnityEditor.dll' } | ForEach-Object FullName)
$sets = [ordered]@{}
$sets['S1_moddir_all'] = $mods + @((Join-Path $M 'UnityEditor.dll'))
$sets['S2_root_facade_plus_mods'] = @((Join-Path $M 'UnityEngine.dll'), (Join-Path $M 'UnityEditor.dll')) + $modsNoDup
$sets['S3_moddir_only'] = $mods
$sets['S4_root_only'] = @((Join-Path $M 'UnityEngine.dll'), (Join-Path $M 'UnityEditor.dll'))
foreach ($k in $sets.Keys) {
  $set = $sets[$k]
  $out = Join-Path $dir ('o_' + $k + '.dll')
  if (Test-Path $out) { Remove-Item $out -Force }
  $a = @('/nologo','/target:library','/utf8output','/langversion:latest','/nowarn:0162,0168,0219,0414,0618','/out:' + $out)
  foreach ($r in $set) { $a += '/r:' + $r }
  foreach ($r in $fw) { $a += '/r:' + $r }
  $a += $src
  $res = & $csc @a 2>&1
  $code = $LASTEXITCODE
  "=== $k refs=$($set.Count + $fw.Count) exit=$code"
  if ($res) { ($res | Select-Object -First 6) -join $NL }
}
