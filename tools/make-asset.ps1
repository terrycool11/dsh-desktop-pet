# -*- coding: utf-8 -*-
# ============================================================
#  DSH 桌宠 · 形象素材工具
#  —— 把一张（浅色背景的）立绘原图变成透明底、可直接给桌宠用的 PNG
#
#    1. 可选：从底部裁掉水印
#    2. 洪水填充抠背景：从四边向内，清除与背景色接近且连通的像素
#       （比 PowerShell 逐像素快很多：C# 编译后执行）
#    3. 缩放到目标宽度
#    4. 可选：输出棋盘底预览图，方便肉眼检查边缘
#
#  用法：
#    powershell -ExecutionPolicy Bypass -File tools/make-asset.ps1
#    powershell -ExecutionPolicy Bypass -File tools/make-asset.ps1 -Source D:\art\my.png -Width 320 -Check
#
#  参数：
#    -Source     原图（png/jpg 都行）      默认 assets/chibi-source.jpg
#    -Out        输出 PNG                  默认 assets/chibi-full.png
#    -Width      输出宽度（像素）          默认 300
#    -Tolerance  背景色容差（0-120）       默认 34，抠不干净调大、抠穿了调小
#    -CropBottom 从底部裁掉多少像素        默认 0（用来去水印）
#    -Check      额外输出棋盘底预览图
# ============================================================

[CmdletBinding()]
param(
  [string]$Source = '',
  [string]$Out = '',
  [int]$Width = 300,
  [int]$Tolerance = 34,
  [int]$CropBottom = 0,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class DshPetBgCut {
  // 从四边向内洪水填充：与边缘连通、且接近背景色的像素 → 透明。
  // 基准色只取左上角小块（四边可能压着人物）。
  public static int Run(string srcPath, string dstPath, int tolerance) {
    using (var src = new Bitmap(srcPath)) {
      int w = src.Width, h = src.Height;
      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.DrawImage(src, new Rectangle(0, 0, w, h));
        }
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int stride = data.Stride;
        byte[] buf = new byte[stride * h];
        Marshal.Copy(data.Scan0, buf, 0, buf.Length);

        int bw = Math.Min(16, w), bh = Math.Min(16, h);
        int sr = 0, sg = 0, sb = 0, n = 0;
        for (int y = 0; y < bh; y++) {
          for (int x = 0; x < bw; x++) {
            int o = y * stride + x * 4;
            sb += buf[o]; sg += buf[o + 1]; sr += buf[o + 2]; n++;
          }
        }
        sr /= n; sg /= n; sb /= n;
        int tol2 = tolerance * tolerance * 3;

        bool[] seen = new bool[w * h];
        var q = new Queue<int>();
        // 只把「匹配背景色」的边缘像素作为种子，否则背景压在人物上时会整片抠穿
        for (int x = 0; x < w; x++) {
          int oT = x * 4, oB = (h - 1) * stride + x * 4;
          int dT = (buf[oT + 2] - sr) * (buf[oT + 2] - sr) + (buf[oT + 1] - sg) * (buf[oT + 1] - sg) + (buf[oT] - sb) * (buf[oT] - sb);
          if (dT <= tol2) q.Enqueue(x);
          int dB = (buf[oB + 2] - sr) * (buf[oB + 2] - sr) + (buf[oB + 1] - sg) * (buf[oB + 1] - sg) + (buf[oB] - sb) * (buf[oB] - sb);
          if (dB <= tol2) q.Enqueue((h - 1) * w + x);
        }
        for (int y = 0; y < h; y++) {
          int oL = y * stride, oR = y * stride + (w - 1) * 4;
          int dL = (buf[oL + 2] - sr) * (buf[oL + 2] - sr) + (buf[oL + 1] - sg) * (buf[oL + 1] - sg) + (buf[oL] - sb) * (buf[oL] - sb);
          if (dL <= tol2) q.Enqueue(y * w);
          int dR = (buf[oR + 2] - sr) * (buf[oR + 2] - sr) + (buf[oR + 1] - sg) * (buf[oR + 1] - sg) + (buf[oR] - sb) * (buf[oR] - sb);
          if (dR <= tol2) q.Enqueue(y * w + w - 1);
        }

        int cleared = 0;
        while (q.Count > 0) {
          int idx = q.Dequeue();
          if (seen[idx]) continue;
          seen[idx] = true;
          int x = idx % w, y = idx / w;
          int o = y * stride + x * 4;
          int dr = buf[o + 2] - sr, dg = buf[o + 1] - sg, db = buf[o] - sb;
          if (dr * dr + dg * dg + db * db > tol2) continue;
          buf[o + 3] = 0;
          cleared++;
          if (x > 0) q.Enqueue(idx - 1);
          if (x < w - 1) q.Enqueue(idx + 1);
          if (y > 0) q.Enqueue(idx - w);
          if (y < h - 1) q.Enqueue(idx + w);
        }

        Marshal.Copy(buf, 0, data.Scan0, buf.Length);
        bmp.UnlockBits(data);
        bmp.Save(dstPath, ImageFormat.Png);
        return cleared;
      }
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Assets = Join-Path $Root 'assets'
if (-not $Source) { $Source = Join-Path $Assets 'chibi-source.jpg' }
# 注意：PowerShell 变量名不分大小写，局部变量 $out 会和参数 $Out 撞车，所以统一用 $OutPath
$OutPath = if ($Out) { $Out } else { Join-Path $Assets 'chibi-full.png' }
$Gen = Join-Path $Assets 'generated'
New-Item -ItemType Directory -Force -Path $Gen | Out-Null

if (-not (Test-Path $Source)) { throw "找不到原图: $Source" }
if ($Tolerance -lt 1 -or $Tolerance -gt 120) { throw "-Tolerance 取 1-120" }

$img = [System.Drawing.Image]::FromFile($Source)
Write-Host "原图: $($img.Width) x $($img.Height)"

# 1) 可选：裁掉底部（水印等）
$keepH = $img.Height - [Math]::Max(0, $CropBottom)
if ($keepH -lt 1) { throw "-CropBottom 比原图还高" }
$rect = New-Object System.Drawing.Rectangle(0, 0, $img.Width, $keepH)
$stage = New-Object System.Drawing.Bitmap($img.Width, $keepH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$sg = [System.Drawing.Graphics]::FromImage($stage)
$sg.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $img.Width, $keepH)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$sg.Dispose(); $img.Dispose()
$stagePath = Join-Path $Gen 'stage.png'
$stage.Save($stagePath, [System.Drawing.Imaging.ImageFormat]::Png)
$stage.Dispose()
Write-Host "裁切后 → $($rect.Width) x $($rect.Height)$(if($CropBottom){"（底部去掉 $CropBottom px）"})"

# 2) 抠背景
$cutPath = Join-Path $Gen 'cut.png'
$cleared = [DshPetBgCut]::Run($stagePath, $cutPath, $Tolerance)
$total = $rect.Width * $rect.Height
Write-Host ("抠背景：清除 {0} 像素（{1:N1}%），容差 {2}" -f $cleared, (100.0 * $cleared / $total), $Tolerance)
if ($cleared -eq 0) { Write-Warning "一个像素都没清掉 —— 原图左上角可能不是背景色，或容差太小" }

# 3) 缩放到目标宽度
$cut = [System.Drawing.Image]::FromFile($cutPath)
$targetH = [int]($cut.Height * $Width / $cut.Width)
$final = New-Object System.Drawing.Bitmap($Width, $targetH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$og = [System.Drawing.Graphics]::FromImage($final)
$og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$og.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$og.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
$og.DrawImage($cut, (New-Object System.Drawing.Rectangle(0, 0, $Width, $targetH)))
$og.Dispose()
New-Item -ItemType Directory -Force -Path (Split-Path $OutPath) | Out-Null
$final.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "$(Split-Path $OutPath -Leaf)  ${Width}x${targetH}  ($([math]::Round((Get-Item $OutPath).Length/1KB)) KB)"

# 4) 可选：棋盘底预览，检查边缘毛刺 / 没抠干净的白边
if ($Check) {
  $plate = New-Object System.Drawing.Bitmap(($Width + 40), ($targetH + 40))
  $cg = [System.Drawing.Graphics]::FromImage($plate)
  $cg.Clear([System.Drawing.Color]::FromArgb(255, 32, 36, 48))
  $b1 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 46, 52, 68))
  for ($y = 0; $y -lt $plate.Height; $y += 20) {
    for ($x = 0; $x -lt $plate.Width; $x += 20) {
      if ((($x / 20) + ($y / 20)) % 2 -eq 0) { $cg.FillRectangle($b1, $x, $y, 20, 20) }
    }
  }
  $b1.Dispose()
  $cg.DrawImage($final, 20, 20, $Width, $targetH)
  $cg.Dispose()
  $checkPath = Join-Path $Gen 'check.png'
  $plate.Save($checkPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $plate.Dispose()
  Write-Host "预览: $checkPath"
}

$cut.Dispose(); $final.Dispose()
Write-Host "完成 → $Out"
