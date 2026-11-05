// 地球的 WebGL 渲染层：只管画，不管交互。
// 球面 = 贴在地表的细点阵（按纬度分行、每行格数按 2 的幂分档，接近等面积），点跟着地球一起转，转动时不闪。
// 颜色由真实的太阳位置决定：白天的陆地是暖纸色，像印出来的地图；夜里的陆地退成一层冷灰；
// 晨昏线附近有一道暖色。球外一圈很淡的大气（向阳一侧偏暖）和静止的星空。
// 电台 = 叠加混合的琥珀色光点：夜里是城市灯火，白天只剩很淡的一点。
// 国家编号图、省/州编号图都是等距圆柱投影，由 tools/build-world.mjs 生成。

const VS_QUAD = `attribute vec2 aP; void main() { gl_Position = vec4(aP, 0.0, 1.0); }`;

const FS_SPHERE = `#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 uCenter;
uniform float uR; uniform float uDpr;
uniform vec3 uU; uniform vec3 uV; uniform vec3 uD;
uniform sampler2D uWorld; uniform sampler2D uAdm;
uniform float uDegA; uniform float uDegB; uniform float uMix;
uniform float uIntro; uniform float uFade;
uniform float uHover; uniform float uSel; uniform float uHoverR; uniform float uSelR;
uniform vec3 uSun;
const vec3 INK = vec3(0.93, 0.9, 0.83);
const vec3 CINNABAR = vec3(0.89, 0.27, 0.17);
const vec3 DAY = vec3(0.95, 0.89, 0.78);    // 白天的陆地：暖纸色
const vec3 NIGHT = vec3(0.3, 0.35, 0.44);   // 夜里的陆地：冷灰
const vec3 DUSK = vec3(1.0, 0.62, 0.34);    // 晨昏线
const vec3 SEA = vec3(0.55, 0.6, 0.72);
const vec3 AIR = vec3(0.45, 0.58, 0.8);
const vec3 AIR_SUN = vec3(0.95, 0.78, 0.55);

vec2 stOf(float lat, float lon) { return vec2(fract((lon + 180.0) / 360.0), clamp((90.0 - lat) / 180.0, 0.0, 0.9999)); }
float idAt(float lat, float lon) { return floor(texture2D(uWorld, stOf(lat, lon)).r * 255.0 + 0.5); }
// 省/州编号是 16 位：低字节在 L 通道，高字节在 A 通道
float admAt(float lat, float lon) {
  vec4 t = texture2D(uAdm, stOf(lat, lon));
  return floor(t.r * 255.0 + 0.5) + floor(t.a * 255.0 + 0.5) * 256.0;
}
vec3 xyzOf(float lat, float lon) { float p = radians(lat); float l = radians(lon); return vec3(cos(p) * cos(l), cos(p) * sin(l), sin(p)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// 一层点阵：返回预乘过的颜色和覆盖率
vec4 dots(float lat, float lon, float deg, float lit, float rim, float fLat, float fLon) {
  float rowf = (min(lat, 89.999) + 90.0) / deg;
  float row = floor(rowf);
  float latc = -90.0 + (row + 0.5) * deg;
  // 每行格数按 2 的幂分档，同一档里的列上下对齐
  float k = floor(log2(1.0 / max(cos(radians(latc)), 0.02)));
  float n = max(1.0, floor(floor(360.0 / deg + 0.5) / exp2(k)));
  float stp = 360.0 / n;
  float colf = (lon + 180.0) / stp;
  float col = floor(colf);
  float lonc = -180.0 + (col + 0.5) * stp;
  float id = idAt(latc, lonc);
  bool land = id > 0.5 && hash(vec2(row, col) + deg) <= uIntro;

  // 格子实际宽高比在 0.5~1 之间，按比例压一下横向，点在地表上是圆的
  float ax = clamp(stp * cos(radians(latc)) / deg, 0.3, 1.0);
  vec2 q = (vec2(fract(colf), fract(rowf)) - 0.5) * vec2(ax, 1.0);
  vec2 w = max(vec2(fLon / stp * ax, fLat / deg), vec2(1e-4)); // 一个屏幕像素合多少格
  float rad = land ? 0.25 : 0.14;
  float e = length(w) * 0.7;
  float a = 1.0 - smoothstep(rad - e, rad + e, length(q));
  // 点在屏幕上太小时改用平均覆盖率，避免摩尔纹
  a = mix(a, min(1.0, 3.1416 * rad * rad / ax), smoothstep(0.22, 0.45, max(w.x, w.y)));

  float s = dot(xyzOf(latc, lonc), uSun);
  float day = smoothstep(-0.03, 0.2, s);
  vec3 c;
  float b;
  if (land) {
    float tw = max(0.0, 1.0 - abs(s) / 0.1);
    c = mix(mix(NIGHT, DAY, day), DUSK, tw * 0.55);
    b = (0.48 + 0.42 * day) * (0.8 + 0.2 * lit);
    float rid = admAt(latc, lonc);
    if (abs(id - uHover) < 0.5 || (uHoverR > 0.5 && abs(rid - uHoverR) < 0.5)) b *= 1.45;
    if (uSelR > 0.5 && abs(rid - uSelR) < 0.5) { c = CINNABAR; b = max(b, 0.8) * 1.2; }
    else if (abs(id - uSel) < 0.5) b *= 1.2;
  } else { c = SEA; b = 0.06 + 0.06 * day; }
  b *= 1.0 + rim * 0.6;
  return vec4(c * b * a, a);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = (frag - uCenter) / uR;
  float r = length(p);
  vec2 pc = r > 0.9995 ? p / r * 0.9995 : p;
  float d = sqrt(1.0 - dot(pc, pc));
  vec3 P = uU * pc.x + uV * pc.y + uD * d;
  float lat = degrees(asin(clamp(P.z, -1.0, 1.0)));
  float lon = degrees(atan(P.y, P.x));
  // 导数在任何分支之前算；经度在 ±180° 处跳变，取两种写法里较小的那个
  float fLat = fwidth(lat);
  float fLon = min(fwidth(lon), fwidth(mod(lon + 360.0, 360.0)));

  vec2 dir = p / max(r, 1e-4);
  // 太阳在屏幕上的方向：大气和亮边都偏向这一侧
  vec2 sunDir = vec2(dot(uSun, uU), dot(uSun, uV));
  sunDir = length(sunDir) > 1e-3 ? normalize(sunDir) : vec2(-0.6, 0.8);
  float side = clamp(dot(dir, sunDir) * 0.5 + 0.5, 0.0, 1.0) * smoothstep(-0.6, 0.4, dot(uSun, uD));
  float inside = 1.0 - smoothstep(1.0 - 1.5 / uR, 1.0, r);

  // 球外：大气 + 静止的星空（星星按 3 个 CSS 像素一格撒，被地球挡住的不画）
  float glow = exp(-max(r - 1.0, 0.0) * 13.0);
  vec3 air = mix(AIR, AIR_SUN, side) * glow * (0.05 + 0.12 * side * side);
  float halo = glow * (0.05 + 0.12 * side * side);
  vec2 sg = frag / uDpr / 3.0;
  vec2 cell = floor(sg);
  float h = hash(cell);
  float star = 0.0;
  if (h > 0.9955) {
    float s = hash(cell + 7.31);
    star = (1.0 - smoothstep(0.12, 0.42, length(fract(sg) - 0.5))) * (0.12 + 0.6 * s * s * s);
  }
  star *= smoothstep(1.0, 1.0 + 3.0 / uR, r);
  vec4 outside = vec4(air + INK * star, max(halo, star));
  if (inside <= 0.0) { gl_FragColor = outside * uFade; return; }

  vec3 N = vec3(pc, d);
  float lit = clamp(dot(N, normalize(vec3(-0.5, 0.62, 0.6))), 0.0, 1.0);
  float rim = pow(smoothstep(0.72, 1.0, r), 2.2) * (0.35 + 0.65 * side);
  // 球体本身是很深的蓝黑，比夜空略亮一点，主要靠点阵勾出轮廓
  vec3 body = mix(vec3(0.035, 0.045, 0.068), vec3(0.058, 0.07, 0.1), lit) + mix(AIR, AIR_SUN, side) * 0.06 * rim;
  vec4 a = dots(lat, lon, uDegA, lit, rim, fLat, fLon);
  vec3 col = body * (1.0 - a.a) + a.rgb;
  if (uMix > 0.0) {
    vec4 b = dots(lat, lon, uDegB, lit, rim, fLat, fLon);
    col = mix(col, body * (1.0 - b.a) + b.rgb, uMix);
  }
  gl_FragColor = (vec4(col, 1.0) * inside + outside * (1.0 - inside)) * uFade;
}`;

const VS_DOTS = `attribute vec4 aDot;
uniform vec3 uU; uniform vec3 uV; uniform vec3 uD;
uniform vec2 uCenter; uniform vec2 uRes; uniform float uR; uniform float uSize; uniform float uAlpha;
uniform vec3 uSun;
varying float vA; varying vec3 vC;
void main() {
  vec3 P = aDot.xyz;
  float d = dot(P, uD);
  vec2 px = uCenter + vec2(dot(P, uU), dot(P, uV)) * uR;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
  // 夜里是灯火，白天压得很淡
  float night = 1.0 - smoothstep(-0.06, 0.08, dot(P, uSun));
  vA = smoothstep(0.0, 0.25, d) * uAlpha * mix(0.22, 1.0, night);
  float h = fract(sin(dot(P.xy * 91.7 + P.z * 13.1, vec2(12.9898, 78.233))) * 43758.5453);
  vC = mix(vec3(1.0, 0.7, 0.4), vec3(1.0, 0.88, 0.7), h);
  float s = (1.3 + log2(aDot.w + 1.0) * 0.7) * uSize * mix(0.75, 1.0, night);
  gl_PointSize = d > 0.0 ? clamp(s * 3.0, 4.0, 60.0) : 0.0;
}`;

const FS_DOTS = `precision mediump float;
varying float vA; varying vec3 vC;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float q = dot(c, c) * 4.0;
  float core = exp(-q * 22.0);
  float i = (core * 0.85 + exp(-q * 5.0) * 0.08) * vA;
  // 灯芯偏白，外圈偏琥珀
  gl_FragColor = vec4(mix(vC, vec3(1.0, 0.96, 0.88), core * 0.6) * i, i * 0.6);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('着色器编译失败：' + gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('着色器链接失败：' + gl.getProgramInfoLog(prog));
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(prog, i).name; u[name] = gl.getUniformLocation(prog, name); }
  return { prog, u };
}

export function createRenderer(canvas, world) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) throw new Error('浏览器不支持 WebGL');
  if (!gl.getExtension('OES_standard_derivatives')) throw new Error('缺少 OES_standard_derivatives');
  const sphere = compile(gl, VS_QUAD, FS_SPHERE);
  const dots = compile(gl, VS_DOTS, FS_DOTS);
  const aP = gl.getAttribLocation(sphere.prog, 'aP');
  const aDot = gl.getAttribLocation(dots.prog, 'aDot');

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // 编号图只能最近邻采样，插值会得到不存在的编号
  function idTexture(format, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, world.TW, world.TH, 0, format, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  const tex = idTexture(gl.LUMINANCE, world.tex);
  const adm = idTexture(gl.LUMINANCE_ALPHA, world.admBytes);

  const dotBuf = gl.createBuffer();
  let dotCount = 0;
  gl.enable(gl.BLEND);

  const setView = (u, f) => {
    gl.uniform3fv(u.uU, f.U); gl.uniform3fv(u.uV, f.V); gl.uniform3fv(u.uD, f.D);
    gl.uniform2f(u.uCenter, f.cx, f.cy); gl.uniform1f(u.uR, f.R);
  };

  return {
    // data：每个点 [x, y, z, 电台数]
    setDots(data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, dotBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      dotCount = data.length / 4;
    },
    // f：画布像素坐标（y 轴朝上），R 为球半径（画布像素）
    render(f) {
      gl.viewport(0, 0, f.w, f.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(sphere.prog);
      const u = sphere.u;
      setView(u, f);
      gl.uniform1f(u.uDpr, f.dpr);
      gl.uniform1f(u.uDegA, f.degA); gl.uniform1f(u.uDegB, f.degB); gl.uniform1f(u.uMix, f.mix);
      gl.uniform1f(u.uIntro, f.intro); gl.uniform1f(u.uFade, f.fade);
      gl.uniform1f(u.uHover, f.hover); gl.uniform1f(u.uSel, f.sel);
      gl.uniform1f(u.uHoverR, f.hoverR); gl.uniform1f(u.uSelR, f.selR);
      gl.uniform3fv(u.uSun, f.sun);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u.uWorld, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, adm); gl.uniform1i(u.uAdm, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(aP);
      gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(aP);

      if (!dotCount || f.dotAlpha <= 0) return;
      gl.blendFunc(gl.ONE, gl.ONE); // 光点叠加：越密越亮
      gl.useProgram(dots.prog);
      const v = dots.u;
      setView(v, f);
      gl.uniform2f(v.uRes, f.w, f.h); gl.uniform1f(v.uSize, f.dotSize); gl.uniform1f(v.uAlpha, f.dotAlpha);
      gl.uniform3fv(v.uSun, f.sun);
      gl.bindBuffer(gl.ARRAY_BUFFER, dotBuf);
      gl.enableVertexAttribArray(aDot);
      gl.vertexAttribPointer(aDot, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, dotCount);
      gl.disableVertexAttribArray(aDot);
    },
  };
}
