// ============================================================
//  CORTADOR - serviço isolado (NÃO mexe na Clara)
//  Serve a página em "/" e corta o video em "/cortar"
// ============================================================

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const YTDLP = path.join(os.tmpdir(), 'yt-dlp_bin');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const MAX_SEGUNDOS = 60 * 60;

// Cookies do YouTube (vêm da variável privada YOUTUBE_COOKIES do Railway)
const COOKIES_PATH = path.join(os.tmpdir(), 'yt-cookies.txt');
let cookiesOk = false;
function prepararCookies() {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw || !raw.trim()) { cookiesOk = false; return; }
  let conteudo = raw.replace(/\r\n/g, '\n').trim();

  // Detecta se veio em base64 (uma linha so, sem tabs) e decodifica
  if (!conteudo.includes('\t') && !conteudo.startsWith('# Netscape') && /^[A-Za-z0-9+/=\s]+$/.test(conteudo)) {
    try {
      const decoded = Buffer.from(conteudo.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (decoded.includes('\t') || decoded.startsWith('# Netscape')) {
        conteudo = decoded;
        console.log('[cortador] cookies vieram em base64, decodificados');
      }
    } catch (e) {}
  }

  if (!conteudo.startsWith('# Netscape')) conteudo = '# Netscape HTTP Cookie File\n' + conteudo;
  try {
    fs.writeFileSync(COOKIES_PATH, conteudo);
    cookiesOk = true;
    const linhas = conteudo.split('\n').filter(l => l && !l.startsWith('#'));
    const comTabs = linhas.filter(l => l.includes('\t')).length;
    console.log(`[cortador] cookies: ${linhas.length} linhas, ${comTabs} com tabs`);
  } catch (e) { cookiesOk = false; }
}
prepararCookies();
console.log('[cortador] cookies:', cookiesOk ? 'carregados' : 'ausentes');

// Proxy (opcional) - 4 variaveis separadas pra evitar dor com URL-encoding
// PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS
let PROXY_URL = null;
(function montarProxy() {
  const h = (process.env.PROXY_HOST || '').trim();
  const p = (process.env.PROXY_PORT || '').trim();
  const u = (process.env.PROXY_USER || '').trim();
  const s = (process.env.PROXY_PASS || '').trim();
  if (!h || !p) return;
  if (u && s) {
    PROXY_URL = `http://${encodeURIComponent(u)}:${encodeURIComponent(s)}@${h}:${p}`;
  } else {
    PROXY_URL = `http://${h}:${p}`;
  }
})();
console.log('[cortador] proxy:', PROXY_URL ? `configurado (${process.env.PROXY_HOST}:${process.env.PROXY_PORT})` : 'sem proxy');

// A pagina do cortador (embutida)
const PAGINA = Buffer.from("PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIiBkYXRhLXRoZW1lPSJkYXJrIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xIj4KPHRpdGxlPkluc3RydWN0aXZhIENvcnRlczwvdGl0bGU+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbSI+CjxsaW5rIHJlbD0icHJlY29ubmVjdCIgaHJlZj0iaHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbSIgY3Jvc3NvcmlnaW4+CjxsaW5rIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9QnJpY29sYWdlK0dyb3Rlc3F1ZTpvcHN6LHdnaHRAMTIuLjk2LDUwMDsxMi4uOTYsNzAwJmZhbWlseT1JbnRlcjp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZkaXNwbGF5PXN3YXAiIHJlbD0ic3R5bGVzaGVldCI+CjxzdHlsZT4KOnJvb3RbZGF0YS10aGVtZT0ibGlnaHQiXXsKICAtLWJnOiNmYWZhZmE7IC0tYmcyOiNmZmZmZmY7IC0tYmczOiNmNGY0ZjU7CiAgLS1saW5lOiNlNGU0ZTc7IC0tbGluZTI6I2Q0ZDRkODsKICAtLWluazojMDkwOTBiOyAtLW11dGVkOiM1MjUyNWI7IC0tZmFpbnQ6I2ExYTFhYTsKICAtLWFjY2VudDojZWE1ODBjOyAtLWFjY2VudC1oOiNjMjQxMGM7IC0tYWNjZW50LXNvZnQ6I2ZmZjdlZDsKICAtLWdvb2Q6IzE2YTM0YTsgLS1nb29kLXNvZnQ6I2YwZmRmNDsKICAtLWJhZDojZGMyNjI2OyAtLWJhZC1zb2Z0OiNmZWYyZjI7CiAgLS1zaGFkb3c6MCAxcHggM3B4IHJnYmEoMCwwLDAsLjA2KSwwIDFweCAycHggcmdiYSgwLDAsMCwuMDQpOwp9Cjpyb290W2RhdGEtdGhlbWU9ImRhcmsiXXsKICAtLWJnOiMwYTBhMGE7IC0tYmcyOiMxNDE0MTY7IC0tYmczOiMxYzFjMWY7CiAgLS1saW5lOiMyNzI3MmE7IC0tbGluZTI6IzNmM2Y0NjsKICAtLWluazojZmFmYWZhOyAtLW11dGVkOiNhMWExYWE7IC0tZmFpbnQ6IzcxNzE3YTsKICAtLWFjY2VudDojZjk3MzE2OyAtLWFjY2VudC1oOiNmYjkyM2M7IC0tYWNjZW50LXNvZnQ6IzJhMWEwZDsKICAtLWdvb2Q6IzIyYzU1ZTsgLS1nb29kLXNvZnQ6IzBmMWYxMjsKICAtLWJhZDojZWY0NDQ0OyAtLWJhZC1zb2Z0OiMxZjEyMTI7CiAgLS1zaGFkb3c6MCAxcHggM3B4IHJnYmEoMCwwLDAsLjQpLDAgMXB4IDJweCByZ2JhKDAsMCwwLC4zKTsKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveDttYXJnaW46MDtwYWRkaW5nOjB9Cmh0bWwsYm9keXtoZWlnaHQ6MTAwJX0KYm9keXsKICBmb250LWZhbWlseTonSW50ZXInLHN5c3RlbS11aSxzYW5zLXNlcmlmO2NvbG9yOnZhcigtLWluayk7YmFja2dyb3VuZDp2YXIoLS1iZyk7CiAgbGluZS1oZWlnaHQ6MS41Oy13ZWJraXQtZm9udC1zbW9vdGhpbmc6YW50aWFsaWFzZWQ7Zm9udC1zaXplOjE0cHg7CiAgdHJhbnNpdGlvbjpiYWNrZ3JvdW5kIC4ycyxjb2xvciAuMnM7Cn0KLndyYXB7bWF4LXdpZHRoOjcyMHB4O21hcmdpbjowIGF1dG87cGFkZGluZzoyNHB4IDIwcHggNjBweH0KLmhkcntkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO21hcmdpbi1ib3R0b206MjhweH0KLmhkci1icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4fQoubG9nb3t3aWR0aDozOHB4O2hlaWdodDozOHB4O2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOnZhcigtLWFjY2VudCk7ZGlzcGxheTpncmlkO3BsYWNlLWl0ZW1zOmNlbnRlcjtjb2xvcjojZmZmO2ZsZXgtc2hyaW5rOjB9Ci5icmFuZC1uYW1le2ZvbnQtZmFtaWx5OidCcmljb2xhZ2UgR3JvdGVzcXVlJyxzYW5zLXNlcmlmO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MThweDtsZXR0ZXItc3BhY2luZzotLjAxZW07bGluZS1oZWlnaHQ6MS4xfQouYnJhbmQtc3Vie2NvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6MTJweDttYXJnaW4tdG9wOjJweH0KLnRoZW1lLXRnbHt3aWR0aDozNnB4O2hlaWdodDozNnB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2NvbG9yOnZhcigtLWluayk7Y3Vyc29yOnBvaW50ZXI7ZGlzcGxheTpncmlkO3BsYWNlLWl0ZW1zOmNlbnRlcjt0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMTVzLGJhY2tncm91bmQgLjE1c30KLnRoZW1lLXRnbDpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tbGluZTIpO2JhY2tncm91bmQ6dmFyKC0tYmczKX0KLnRoZW1lLXRnbCBzdmd7d2lkdGg6MTZweDtoZWlnaHQ6MTZweH0KW2RhdGEtdGhlbWU9ImRhcmsiXSAuaWNvbi1zdW57ZGlzcGxheTpibG9ja31bZGF0YS10aGVtZT0iZGFyayJdIC5pY29uLW1vb257ZGlzcGxheTpub25lfQpbZGF0YS10aGVtZT0ibGlnaHQiXSAuaWNvbi1zdW57ZGlzcGxheTpub25lfVtkYXRhLXRoZW1lPSJsaWdodCJdIC5pY29uLW1vb257ZGlzcGxheTpibG9ja30KCi50YWJze2Rpc3BsYXk6aW5saW5lLWZsZXg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMXB4O3BhZGRpbmc6M3B4O21hcmdpbi1ib3R0b206MjBweDtnYXA6MnB4fQoudGFie2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjowO2NvbG9yOnZhcigtLW11dGVkKTtmb250OjYwMCAxM3B4ICdJbnRlcicsc2Fucy1zZXJpZjtwYWRkaW5nOjdweCAxNHB4O2JvcmRlci1yYWRpdXM6OHB4O2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246YWxsIC4xNXN9Ci50YWI6aG92ZXJ7Y29sb3I6dmFyKC0taW5rKX0KLnRhYi5pcy1hY3RpdmV7YmFja2dyb3VuZDp2YXIoLS1iZzMpO2NvbG9yOnZhcigtLWluayl9Ci50YWIgc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHh9CgoucGFuZWx7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MjJweH0KLnBhbmVsLmhpZGRlbntkaXNwbGF5Om5vbmV9Ci5maWVsZHttYXJnaW4tYm90dG9tOjE2cHh9Ci5maWVsZDpsYXN0LW9mLXR5cGV7bWFyZ2luLWJvdHRvbTowfQpsYWJlbHtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLWJvdHRvbTo2cHg7bGV0dGVyLXNwYWNpbmc6LjAxZW19Ci5sYWJlbC1vcHR7Y29sb3I6dmFyKC0tZmFpbnQpO2ZvbnQtd2VpZ2h0OjUwMDt0ZXh0LXRyYW5zZm9ybTpub25lO2xldHRlci1zcGFjaW5nOjB9CmlucHV0W3R5cGU9dGV4dF17CiAgd2lkdGg6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWJnKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OXB4OwogIGNvbG9yOnZhcigtLWluayk7Zm9udDo0MDAgMTRweCAnSW50ZXInLHNhbnMtc2VyaWY7cGFkZGluZzoxMHB4IDEzcHg7b3V0bGluZTpub25lOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4xMnMsYm94LXNoYWRvdyAuMTJzOwp9CmlucHV0W3R5cGU9dGV4dF06aG92ZXJ7Ym9yZGVyLWNvbG9yOnZhcigtLWxpbmUyKX0KaW5wdXRbdHlwZT10ZXh0XTpmb2N1c3tib3JkZXItY29sb3I6dmFyKC0tYWNjZW50KTtib3gtc2hhZG93OjAgMCAwIDNweCB2YXIoLS1hY2NlbnQtc29mdCl9CmlucHV0OjpwbGFjZWhvbGRlcntjb2xvcjp2YXIoLS1mYWludCl9Ci5yb3d7ZGlzcGxheTpmbGV4O2dhcDoxMnB4fQoucm93ID4gZGl2e2ZsZXg6MX0KLmhpbnR7Zm9udC1zaXplOjEyLjVweDtjb2xvcjp2YXIoLS1mYWludCk7bWFyZ2luLXRvcDoxMHB4O2xpbmUtaGVpZ2h0OjEuNTV9Ci5oaW50IGJ7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtd2VpZ2h0OjYwMH0KCi5mbXQtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLDFmcik7Z2FwOjEwcHg7bWFyZ2luLXRvcDo2cHh9Ci5mbXQtY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWJnKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTFweDtwYWRkaW5nOjEycHggMTBweCAxNHB4O2N1cnNvcjpwb2ludGVyO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7dGV4dC1hbGlnbjpjZW50ZXI7dHJhbnNpdGlvbjphbGwgLjE1cztmb250LWZhbWlseTppbmhlcml0O2NvbG9yOnZhcigtLWluayl9Ci5mbXQtY2FyZDpob3Zlcntib3JkZXItY29sb3I6dmFyKC0tbGluZTIpfQouZm10LWNhcmQuaXMtYWN0aXZle2JvcmRlci1jb2xvcjp2YXIoLS1hY2NlbnQpO2JhY2tncm91bmQ6dmFyKC0tYWNjZW50LXNvZnQpO2JveC1zaGFkb3c6MCAwIDAgMXB4IHZhcigtLWFjY2VudCl9Ci5mbXQtcHJldnt3aWR0aDo0OHB4O2hlaWdodDo4MHB4O2JvcmRlci1yYWRpdXM6NnB4O3Bvc2l0aW9uOnJlbGF0aXZlO292ZXJmbG93OmhpZGRlbjtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7YmFja2dyb3VuZDp2YXIoLS1iZzMpfQouZm10LXByZXYgLmlubmVyLWJhcntwb3NpdGlvbjphYnNvbHV0ZTt3aWR0aDoxMDAlfQouZm10LXRpdGxle2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLWluayk7bGluZS1oZWlnaHQ6MS4yfQouZm10LWRlc2N7Zm9udC1zaXplOjExcHg7Y29sb3I6dmFyKC0tbXV0ZWQpO2xpbmUtaGVpZ2h0OjEuM30KCi5idG57ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2dhcDo4cHg7d2lkdGg6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWFjY2VudCk7Y29sb3I6I2ZmZjtib3JkZXI6MDtib3JkZXItcmFkaXVzOjlweDtwYWRkaW5nOjExcHggMTZweDtmb250OjYwMCAxNHB4ICdJbnRlcicsc2Fucy1zZXJpZjtjdXJzb3I6cG9pbnRlcjttYXJnaW4tdG9wOjIwcHg7dHJhbnNpdGlvbjpiYWNrZ3JvdW5kIC4xMnMsdHJhbnNmb3JtIC4wOHM7fQouYnRuOmhvdmVye2JhY2tncm91bmQ6dmFyKC0tYWNjZW50LWgpfQouYnRuOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUoLjk5KX0KLmJ0bjpkaXNhYmxlZHtvcGFjaXR5Oi41O2N1cnNvcjpub3QtYWxsb3dlZH0KLmJ0biBzdmd7d2lkdGg6MTVweDtoZWlnaHQ6MTVweH0KCi5zdGF0dXN7bWFyZ2luLXRvcDoxNnB4fQouYWxlcnR7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyLXJhZGl1czo5cHg7Zm9udC1zaXplOjEzLjVweDtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtib3JkZXI6MXB4IHNvbGlkfQouYWxlcnQgc3Zne3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7ZmxleC1zaHJpbms6MDttYXJnaW4tdG9wOjJweH0KLmFsZXJ0LmxvYWRpbmd7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlci1jb2xvcjp2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS1tdXRlZCl9Ci5hbGVydC5va3tiYWNrZ3JvdW5kOnZhcigtLWdvb2Qtc29mdCk7Ym9yZGVyLWNvbG9yOnZhcigtLWdvb2QpO2NvbG9yOnZhcigtLWdvb2QpfQouYWxlcnQuYmFke2JhY2tncm91bmQ6dmFyKC0tYmFkLXNvZnQpO2JvcmRlci1jb2xvcjp2YXIoLS1iYWQpO2NvbG9yOnZhcigtLWJhZCk7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2FsaWduLWl0ZW1zOnN0cmV0Y2h9Ci5hbGVydC5iYWQgLmJhZC1oZWFke2Rpc3BsYXk6ZmxleDtnYXA6MTBweDthbGlnbi1pdGVtczpmbGV4LXN0YXJ0fQouYWxlcnQgLmRldHttYXJnaW4tdG9wOjhweDtmb250LWZhbWlseTp1aS1tb25vc3BhY2UsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxMXB4O2xpbmUtaGVpZ2h0OjEuNTt3aGl0ZS1zcGFjZTpwcmUtd3JhcDtvcGFjaXR5Oi43NTttYXgtaGVpZ2h0OjEyMHB4O292ZXJmbG93OmF1dG99Ci5hbGVydC5vayAub2stbGlua3ttYXJnaW4tdG9wOjhweH0KLmFsZXJ0Lm9rIGF7Y29sb3I6dmFyKC0tZ29vZCk7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZTtmb250LXdlaWdodDo1MDB9Cgouc3Bpbm5lcntkaXNwbGF5OmlubGluZS1ibG9jazt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2JvcmRlcjoycHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXRvcC1jb2xvcjp2YXIoLS1hY2NlbnQpO2JvcmRlci1yYWRpdXM6NTAlO2FuaW1hdGlvbjpzcGluIC43cyBsaW5lYXIgaW5maW5pdGU7ZmxleC1zaHJpbms6MDttYXJnaW4tdG9wOjFweH0KQGtleWZyYW1lcyBzcGlue3Rve3RyYW5zZm9ybTpyb3RhdGUoMzYwZGVnKX19Cgpmb290ZXJ7bWFyZ2luLXRvcDozMnB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLWZhaW50KTtmb250LXNpemU6MTEuNXB4fQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJ3cmFwIj4KCjxoZWFkZXIgY2xhc3M9ImhkciI+CiAgPGRpdiBjbGFzcz0iaGRyLWJyYW5kIj4KICAgIDxkaXYgY2xhc3M9ImxvZ28iPgogICAgICA8c3ZnIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iNiIgY3k9IjYiIHI9IjMiLz48Y2lyY2xlIGN4PSI2IiBjeT0iMTgiIHI9IjMiLz48bGluZSB4MT0iMjAiIHkxPSI0IiB4Mj0iOC4xMiIgeTI9IjE1Ljg4Ii8+PGxpbmUgeDE9IjE0LjQ3IiB5MT0iMTQuNDgiIHgyPSIyMCIgeTI9IjIwIi8+PGxpbmUgeDE9IjguMTIiIHkxPSI4LjEyIiB4Mj0iMTIiIHkyPSIxMiIvPjwvc3ZnPgogICAgPC9kaXY+CiAgICA8ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJicmFuZC1uYW1lIj5JbnN0cnVjdGl2YSBDb3J0ZXM8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYnJhbmQtc3ViIj5Db3J0ZXMgZGUgYXVsYSBlbSBzZWd1bmRvcy48L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgogIDxidXR0b24gY2xhc3M9InRoZW1lLXRnbCIgb25jbGljaz0idG9nZ2xlVGhlbWUoKSIgYXJpYS1sYWJlbD0iQWx0ZXJuYXIgdGVtYSI+CiAgICA8c3ZnIGNsYXNzPSJpY29uLXN1biIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjQiLz48cGF0aCBkPSJNMTIgMnYyTTEyIDIwdjJNNC45MyA0LjkzbDEuNDEgMS40MU0xNy42NiAxNy42NmwxLjQxIDEuNDFNMiAxMmgyTTIwIDEyaDJNNC45MyAxOS4wN2wxLjQxLTEuNDFNMTcuNjYgNi4zNGwxLjQxLTEuNDEiLz48L3N2Zz4KICAgIDxzdmcgY2xhc3M9Imljb24tbW9vbiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMSAxMi43OUE5IDkgMCAxIDEgMTEuMjEgMyA3IDcgMCAwIDAgMjEgMTIuNzl6Ii8+PC9zdmc+CiAgPC9idXR0b24+CjwvaGVhZGVyPgoKPG5hdiBjbGFzcz0idGFicyI+CiAgPGJ1dHRvbiBjbGFzcz0idGFiIGlzLWFjdGl2ZSIgZGF0YS10YWI9Im5vcm1hbCIgb25jbGljaz0ic2V0VGFiKCdub3JtYWwnKSI+CiAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMi4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjMiIHk9IjYiIHdpZHRoPSIxOCIgaGVpZ2h0PSIxMiIgcng9IjIiLz48L3N2Zz4KICAgIENvcnRlIG5vcm1hbAogIDwvYnV0dG9uPgogIDxidXR0b24gY2xhc3M9InRhYiIgZGF0YS10YWI9InNob3J0cyIgb25jbGljaz0ic2V0VGFiKCdzaG9ydHMnKSI+CiAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMi4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxyZWN0IHg9IjgiIHk9IjMiIHdpZHRoPSI4IiBoZWlnaHQ9IjE4IiByeD0iMiIvPjxwYXRoIGQ9Ik0xMSAxOGgyIi8+PC9zdmc+CiAgICBTaG9ydHMKICA8L2J1dHRvbj4KPC9uYXY+Cgo8c2VjdGlvbiBjbGFzcz0icGFuZWwiIGlkPSJwYW5lbC1ub3JtYWwiPgogIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgIDxsYWJlbCBmb3I9InVybC1uIj5MaW5rIGRvIHbDrWRlbzwvbGFiZWw+CiAgICA8aW5wdXQgaWQ9InVybC1uIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iaHR0cHM6Ly95b3V0dWJlLmNvbS93YXRjaD92PS4uLiI+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0icm93Ij4KICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgPGxhYmVsIGZvcj0iaW5pLW4iPkRvIG1pbnV0bzwvbGFiZWw+CiAgICAgIDxpbnB1dCBpZD0iaW5pLW4iIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSI0OjMyIj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICA8bGFiZWwgZm9yPSJmaW0tbiI+QXTDqSBvIG1pbnV0bzwvbGFiZWw+CiAgICAgIDxpbnB1dCBpZD0iZmltLW4iIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSI2OjEwIj4KICAgIDwvZGl2PgogIDwvZGl2PgogIDxwIGNsYXNzPSJoaW50Ij5Gb3JtYXRvOiA8Yj40OjMyPC9iPiAobWludXRvOnNlZ3VuZG8pLiBQYXNzYW5kbyBkZSB1bWEgaG9yYSwgPGI+MTowNDoxMDwvYj4uIENvcnRlcyBkbyBtZXNtbyB2w61kZW8gZmljYW0gZW0gY2FjaGUgcG9yIDFoIGUgc8OjbyBpbnN0YW50w6JuZW9zLjwvcD4KICA8YnV0dG9uIGNsYXNzPSJidG4iIG9uY2xpY2s9ImV4ZWN1dGFyKCdub3JtYWwnKSI+CiAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMi40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiA1djE0Ii8+PHBhdGggZD0iTTE5IDEybC03IDctNy03Ii8+PC9zdmc+CiAgICBDb3J0YXIgZSBiYWl4YXIKICA8L2J1dHRvbj4KPC9zZWN0aW9uPgoKPHNlY3Rpb24gY2xhc3M9InBhbmVsIGhpZGRlbiIgaWQ9InBhbmVsLXNob3J0cyI+CiAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgPGxhYmVsIGZvcj0idXJsLXMiPkxpbmsgZG8gdsOtZGVvPC9sYWJlbD4KICAgIDxpbnB1dCBpZD0idXJsLXMiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJodHRwczovL3lvdXR1YmUuY29tL3dhdGNoP3Y9Li4uIj4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJyb3ciPgogICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICA8bGFiZWwgZm9yPSJpbmktcyI+RG8gbWludXRvPC9sYWJlbD4KICAgICAgPGlucHV0IGlkPSJpbmktcyIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IjE6MDAiPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgIDxsYWJlbCBmb3I9ImZpbS1zIj5BdMOpIG8gbWludXRvPC9sYWJlbD4KICAgICAgPGlucHV0IGlkPSJmaW0tcyIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IjI6MDAiPgogICAgPC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgIDxsYWJlbD5Fc3RpbG8gZG8gU2hvcnRzPC9sYWJlbD4KICAgIDxkaXYgY2xhc3M9ImZtdC1ncmlkIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZm10LWNhcmQgaXMtYWN0aXZlIiBkYXRhLWZvcm1hdD0iY2VudHJvX2JsdXIiIG9uY2xpY2s9InNldEZvcm1hdG8oJ2NlbnRyb19ibHVyJykiPgogICAgICAgIDxkaXYgY2xhc3M9ImZtdC1wcmV2Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImlubmVyLWJhciIgc3R5bGU9InRvcDowO2JvdHRvbTowO2JhY2tncm91bmQ6cmVwZWF0aW5nLWxpbmVhci1ncmFkaWVudCg0NWRlZyx2YXIoLS1saW5lKSx2YXIoLS1saW5lKSAzcHgsdmFyKC0tYmczKSAzcHgsdmFyKC0tYmczKSA2cHgpO29wYWNpdHk6LjUiPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iaW5uZXItYmFyIiBzdHlsZT0idG9wOjM0cHg7aGVpZ2h0OjE4cHg7YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpIj48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8c3BhbiBjbGFzcz0iZm10LXRpdGxlIj5DZW50cm8gKyBibHVyPC9zcGFuPgogICAgICAgIDxzcGFuIGNsYXNzPSJmbXQtZGVzYyI+TWFudMOpbSB0dWRvPC9zcGFuPgogICAgICA8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZm10LWNhcmQiIGRhdGEtZm9ybWF0PSJjcm9wIiBvbmNsaWNrPSJzZXRGb3JtYXRvKCdjcm9wJykiPgogICAgICAgIDxkaXYgY2xhc3M9ImZtdC1wcmV2Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImlubmVyLWJhciIgc3R5bGU9InRvcDowO2JvdHRvbTowO2JhY2tncm91bmQ6dmFyKC0tYWNjZW50KSI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPHNwYW4gY2xhc3M9ImZtdC10aXRsZSI+Q3JvcCBjZW50cmFsPC9zcGFuPgogICAgICAgIDxzcGFuIGNsYXNzPSJmbXQtZGVzYyI+Wm9vbSBubyBtZWlvPC9zcGFuPgogICAgICA8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iZm10LWNhcmQiIGRhdGEtZm9ybWF0PSJ0YWxraW5nX3RleHRvIiBvbmNsaWNrPSJzZXRGb3JtYXRvKCd0YWxraW5nX3RleHRvJykiPgogICAgICAgIDxkaXYgY2xhc3M9ImZtdC1wcmV2Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImlubmVyLWJhciIgc3R5bGU9InRvcDowO2JvdHRvbTowO2JhY2tncm91bmQ6dmFyKC0tYWNjZW50KSI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJpbm5lci1iYXIiIHN0eWxlPSJib3R0b206OHB4O2hlaWdodDoxNHB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNyk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiNmZmY7Zm9udC1zaXplOjdweDtmb250LXdlaWdodDo3MDA7bGV0dGVyLXNwYWNpbmc6LjVweCI+VEVYVE88L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8c3BhbiBjbGFzcz0iZm10LXRpdGxlIj5UYWxraW5nICsgdGV4dG88L3NwYW4+CiAgICAgICAgPHNwYW4gY2xhc3M9ImZtdC1kZXNjIj5Db20gbGVnZW5kYSBmaXhhPC9zcGFuPgogICAgICA8L2J1dHRvbj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGNsYXNzPSJmaWVsZCIgaWQ9InRleHRvLWZpZWxkIiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgIDxsYWJlbCBmb3I9InRleHRvLXMiPlRleHRvIGVtYmFpeG8gPHNwYW4gY2xhc3M9ImxhYmVsLW9wdCI+KG9wY2lvbmFsKTwvc3Bhbj48L2xhYmVsPgogICAgPGlucHV0IGlkPSJ0ZXh0by1zIiB0eXBlPSJ0ZXh0IiBtYXhsZW5ndGg9IjgwIiBwbGFjZWhvbGRlcj0iRVg6IEVMRSBRVUVSIEFMR1VFTSBRVUUiPgogICAgPHAgY2xhc3M9ImhpbnQiPkF0w6kgODAgY2FyYWN0ZXJlcyBlbSBtYWnDunNjdWxhcywgZm9udGUgZ3Jvc3NhIGJyYW5jYS4gRGVpeGEgdmF6aW8gc2UgcXVpc2VyIHPDsyBvIHZlcnRpY2FsIHNlbSB0ZXh0by48L3A+CiAgPC9kaXY+CgogIDxwIGNsYXNzPSJoaW50Ij5JZGVhbCBwcmEgU2hvcnRzL1JlZWxzOiBhdMOpIDxiPjYwIHNlZ3VuZG9zPC9iPiBkZSBkdXJhw6fDo28uIEdlcmEgZW0gOToxNiAoNzIweDEyODApLjwvcD4KICA8YnV0dG9uIGNsYXNzPSJidG4iIG9uY2xpY2s9ImV4ZWN1dGFyKCdzaG9ydHMnKSI+CiAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMi40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiA1djE0Ii8+PHBhdGggZD0iTTE5IDEybC03IDctNy03Ii8+PC9zdmc+CiAgICBHZXJhciBTaG9ydHMKICA8L2J1dHRvbj4KPC9zZWN0aW9uPgoKPGRpdiBjbGFzcz0ic3RhdHVzIiBpZD0ic3RhdHVzIj48L2Rpdj4KCjxmb290ZXI+SW5zdHJ1Y3RpdmEgQ29ydGVzIMK3IGZlaXRvIHByYSBkZW50cm8gZGUgY2FzYTwvZm9vdGVyPgoKPC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwpsZXQgZm9ybWF0b1Nob3J0cyA9ICdjZW50cm9fYmx1cic7CgooZnVuY3Rpb24gaW5pdFRlbWEoKXsKICBsZXQgc2Fsdm8gPSBudWxsOwogIHRyeXsgc2Fsdm8gPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnaW5zdHJ1Y3RpdmEtdGVtYScpOyB9Y2F0Y2goZSl7fQogIGlmKHNhbHZvID09PSAnbGlnaHQnIHx8IHNhbHZvID09PSAnZGFyaycpIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5zZXRBdHRyaWJ1dGUoJ2RhdGEtdGhlbWUnLCBzYWx2byk7Cn0pKCk7CgpmdW5jdGlvbiB0b2dnbGVUaGVtZSgpewogIGNvbnN0IGF0dWFsID0gZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmdldEF0dHJpYnV0ZSgnZGF0YS10aGVtZScpIHx8ICdkYXJrJzsKICBjb25zdCBub3ZvID0gYXR1YWwgPT09ICdkYXJrJyA/ICdsaWdodCcgOiAnZGFyayc7CiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnNldEF0dHJpYnV0ZSgnZGF0YS10aGVtZScsIG5vdm8pOwogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2luc3RydWN0aXZhLXRlbWEnLCBub3ZvKTsgfWNhdGNoKGUpe30KfQoKZnVuY3Rpb24gc2V0VGFiKG5vbWUpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWInKS5mb3JFYWNoKHQgPT4gdC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1hY3RpdmUnLCB0LmRhdGFzZXQudGFiID09PSBub21lKSk7CiAgJCgncGFuZWwtbm9ybWFsJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgbm9tZSAhPT0gJ25vcm1hbCcpOwogICQoJ3BhbmVsLXNob3J0cycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIG5vbWUgIT09ICdzaG9ydHMnKTsKICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSAnJzsKfQoKZnVuY3Rpb24gc2V0Rm9ybWF0byhmKXsKICBmb3JtYXRvU2hvcnRzID0gZjsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZm10LWNhcmQnKS5mb3JFYWNoKGMgPT4gYy5jbGFzc0xpc3QudG9nZ2xlKCdpcy1hY3RpdmUnLCBjLmRhdGFzZXQuZm9ybWF0ID09PSBmKSk7CiAgJCgndGV4dG8tZmllbGQnKS5zdHlsZS5kaXNwbGF5ID0gZiA9PT0gJ3RhbGtpbmdfdGV4dG8nID8gJ2Jsb2NrJyA6ICdub25lJzsKfQoKYXN5bmMgZnVuY3Rpb24gZXhlY3V0YXIobW9kbyl7CiAgY29uc3QgdXJsID0gJChtb2RvID09PSAnbm9ybWFsJyA/ICd1cmwtbicgOiAndXJsLXMnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgaW5pY2lvID0gJChtb2RvID09PSAnbm9ybWFsJyA/ICdpbmktbicgOiAnaW5pLXMnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgZmltID0gJChtb2RvID09PSAnbm9ybWFsJyA/ICdmaW0tbicgOiAnZmltLXMnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgZm9ybWF0byA9IG1vZG8gPT09ICdub3JtYWwnID8gJ29yaWdpbmFsJyA6IGZvcm1hdG9TaG9ydHM7CiAgY29uc3QgdGV4dG8gPSBtb2RvID09PSAnc2hvcnRzJyAmJiBmb3JtYXRvID09PSAndGFsa2luZ190ZXh0bycgPyAkKCd0ZXh0by1zJykudmFsdWUudHJpbSgpIDogJyc7CgogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9ICcnOwogIGlmKCF1cmwpIHJldHVybiBtb3N0cmFFcnJvKCdDb2xhIG8gbGluayBkbyB2w61kZW8gbm8gY2FtcG8gZGUgY2ltYS4nKTsKICBpZighaW5pY2lvIHx8ICFmaW0pIHJldHVybiBtb3N0cmFFcnJvKCdQcmVlbmNoZSBvcyBkb2lzIGNhbXBvcyBkZSB0ZW1wby4nKTsKCiAgY29uc3QgYm90b2VzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmJ0bicpOwogIGJvdG9lcy5mb3JFYWNoKGIgPT4gYi5kaXNhYmxlZCA9IHRydWUpOwogIGNvbnN0IG1zZyA9IGZvcm1hdG8gPT09ICdvcmlnaW5hbCcgPyAnQ29ydGFuZG8gbyB0cmVjaG8uLi4nIDogJ0dlcmFuZG8gU2hvcnRzIHZlcnRpY2FsIChwb2RlIGxldmFyIHVucyAyMHMpLi4uJzsKICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iYWxlcnQgbG9hZGluZyI+PHNwYW4gY2xhc3M9InNwaW5uZXIiPjwvc3Bhbj48c3Bhbj4ke21zZ308L3NwYW4+PC9kaXY+YDsKCiAgdHJ5ewogICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goJy9jb3J0YXInLCB7CiAgICAgIG1ldGhvZDonUE9TVCcsCiAgICAgIGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgdXJsLCBpbmljaW8sIGZpbSwgZm9ybWF0bywgdGV4dG8gfSkKICAgIH0pOwogICAgY29uc3QgdGlwbyA9IHJlcy5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykgfHwgJyc7CiAgICBpZih0aXBvLmluY2x1ZGVzKCdhcHBsaWNhdGlvbi9qc29uJykpewogICAgICBjb25zdCBqID0gYXdhaXQgcmVzLmpzb24oKTsKICAgICAgcmV0dXJuIG1vc3RyYUVycm8oai5lcnJvIHx8ICdOYW8gZGV1IHByYSBjb3J0YXIgZXNzZSB2aWRlby4nLCBqLmRldGFsaGUpOwogICAgfQogICAgY29uc3QgYmxvYiA9IGF3YWl0IHJlcy5ibG9iKCk7CiAgICBjb25zdCBsaW5rID0gVVJMLmNyZWF0ZU9iamVjdFVSTChibG9iKTsKICAgIGNvbnN0IHN1Zml4byA9IGZvcm1hdG8gPT09ICdvcmlnaW5hbCcgPyAnJyA6ICdfJyArIGZvcm1hdG87CiAgICBjb25zdCBub21lID0gYGNvcnRlXyR7aW5pY2lvLnJlcGxhY2UoLzovZywnLScpfV9hXyR7ZmltLnJlcGxhY2UoLzovZywnLScpfSR7c3VmaXhvfS5tcDRgOwogICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICAgIGEuaHJlZiA9IGxpbms7IGEuZG93bmxvYWQgPSBub21lOyBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpOyBhLmNsaWNrKCk7IGEucmVtb3ZlKCk7CiAgICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iYWxlcnQgb2siPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMjAgNiA5IDE3IDQgMTIiLz48L3N2Zz48ZGl2PjxkaXY+Q29ydGUgcHJvbnRvLCBvIGRvd25sb2FkIGNvbWXDp291LjwvZGl2PjxkaXYgY2xhc3M9Im9rLWxpbmsiPjxhIGhyZWY9IiR7bGlua30iIGRvd25sb2FkPSIke25vbWV9Ij5CYWl4YXIgZGUgbm92bzwvYT48L2Rpdj48L2Rpdj48L2Rpdj5gOwogIH1jYXRjaChlKXsKICAgIG1vc3RyYUVycm8oJ07Do28gY29uc2VndWkgZmFsYXIgY29tIG8gc2Vydmlkb3IuICgnKyBlLm1lc3NhZ2UgKycpJyk7CiAgfWZpbmFsbHl7CiAgICBib3RvZXMuZm9yRWFjaChiID0+IGIuZGlzYWJsZWQgPSBmYWxzZSk7CiAgfQp9CgpmdW5jdGlvbiBtb3N0cmFFcnJvKG1zZywgZGV0YWxoZSl7CiAgY29uc3QgZGV0ID0gZGV0YWxoZSA/IGA8ZGl2IGNsYXNzPSJkZXQiPiR7U3RyaW5nKGRldGFsaGUpLnJlcGxhY2UoL1smPD5dL2csIGMgPT4gKHsnJic6JyZhbXA7JywnPCc6JyZsdDsnLCc+JzonJmd0Oyd9W2NdKSl9PC9kaXY+YCA6ICcnOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJhbGVydCBiYWQiPjxkaXYgY2xhc3M9ImJhZC1oZWFkIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMi40IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PGxpbmUgeDE9IjEyIiB5MT0iOCIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyLjAxIiB5Mj0iMTYiLz48L3N2Zz48c3Bhbj4ke21zZ308L3NwYW4+PC9kaXY+JHtkZXR9PC9kaXY+YDsKfQo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==", 'base64').toString('utf8');

let prontoYtdlp = null;
function garantirYtdlp() {
  if (prontoYtdlp) return prontoYtdlp;
  prontoYtdlp = new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP)) { try { fs.chmodSync(YTDLP, 0o755); } catch (e) {} return resolve(); }
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Nao consegui baixar o yt-dlp (' + r.statusCode + ')'));
        const arq = fs.createWriteStream(YTDLP);
        r.pipe(arq);
        arq.on('finish', () => arq.close(() => { fs.chmodSync(YTDLP, 0o755); resolve(); }));
      }).on('error', reject);
    };
    baixar(YTDLP_URL);
  });
  return prontoYtdlp;
}

// ---- Baixa o ffmpeg (eugeneware/ffmpeg-static - .gz, descompacta com zlib nativo) ----
const FFMPEG = path.join(os.tmpdir(), 'ffmpeg_bin');
const FFMPEG_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-x64.gz';
let prontoFfmpeg = null;
function garantirFfmpeg() {
  if (prontoFfmpeg) return prontoFfmpeg;
  prontoFfmpeg = new Promise((resolve, reject) => {
    if (fs.existsSync(FFMPEG)) { try { fs.chmodSync(FFMPEG, 0o755); } catch (e) {} return resolve(); }
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Nao consegui baixar o ffmpeg (' + r.statusCode + ')'));
        const out = fs.createWriteStream(FFMPEG);
        r.pipe(zlib.createGunzip()).pipe(out);
        out.on('finish', () => out.close(() => { fs.chmodSync(FFMPEG, 0o755); console.log('[cortador] ffmpeg pronto'); resolve(); }));
        out.on('error', reject);
      }).on('error', reject);
    };
    baixar(FFMPEG_URL);
  });
  return prontoFfmpeg;
}

// ---- Baixa fonte Anton (usada pra texto em Shorts) ----
const FONTE = path.join(os.tmpdir(), 'Anton-Regular.ttf');
const FONTE_URL = 'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf';
let prontoFonte = null;
function garantirFonte() {
  if (prontoFonte) return prontoFonte;
  prontoFonte = new Promise((resolve, reject) => {
    if (fs.existsSync(FONTE)) return resolve();
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Nao consegui baixar a fonte (' + r.statusCode + ')'));
        const out = fs.createWriteStream(FONTE);
        r.pipe(out);
        out.on('finish', () => out.close(() => { console.log('[cortador] fonte Anton pronta'); resolve(); }));
        out.on('error', reject);
      }).on('error', reject);
    };
    baixar(FONTE_URL);
  });
  return prontoFonte;
}

// ---- Cache de videos baixados (1 hora) ----
const CACHE_DIR = path.join(os.tmpdir(), 'cortador-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;

function cachePathPara(url, ext) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return path.join(CACHE_DIR, hash + '.' + (ext || 'mp4'));
}

function limparCacheAntigo() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const agora = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (agora - stat.mtimeMs > CACHE_TTL_MS) {
          fs.unlinkSync(fp);
          console.log('[cortador] cache: removido', f, '(velho)');
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function linkValido(u) {
  return typeof u === 'string' && /^https:\/\/(www\.|m\.)?(youtube\.com\/|youtu\.be\/)/.test(u.trim());
}
function tempoValido(t) {
  return typeof t === 'string' && /^(\d{1,2}:)?\d{1,2}:\d{2}$|^\d{1,3}(:\d{2}){0,2}$|^\d+$/.test(t.trim());
}
function paraSegundos(t) {
  const p = String(t).trim().split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

app.get('/', (_req, res) => res.type('html').send(PAGINA));
app.get('/status', (_req, res) => {
  let videosCacheados = 0;
  try { if (fs.existsSync(CACHE_DIR)) videosCacheados = fs.readdirSync(CACHE_DIR).length; } catch (e) {}
  res.json({ ok: true, servico: 'cortador', versao: 33, cookies: cookiesOk, proxy: PROXY_URL ? (process.env.PROXY_HOST + ':' + process.env.PROXY_PORT) : false, videosNoCache: videosCacheados });
});

// Helper: roda um comando e retorna {codigo, sinal, stdout, stderr}
function executar(cmd, args, label) {
  return new Promise((resolve) => {
    console.log('[cortador]', label, 'iniciando...');
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (codigo, sinal) => {
      console.log('[cortador]', label, 'terminou com codigo', codigo, 'sinal', sinal);
      if (stderr) console.log('[cortador] stderr de', label + ':\n' + stderr.slice(-1500));
      resolve({ codigo, sinal, stdout, stderr });
    });
    proc.on('error', (err) => {
      resolve({ codigo: -1, sinal: null, stdout: '', stderr: 'erro ao executar: ' + err.message });
    });
  });
}

app.post('/cortar', async (req, res) => {
  const url = (req.body.url || '').trim();
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();
  const formato = String(req.body.formato || 'original').trim();
  const texto = String(req.body.texto || '').trim().slice(0, 80);

  if (!linkValido(url)) return res.status(400).json({ erro: 'Cole um link valido do YouTube.' });
  if (!tempoValido(inicio) || !tempoValido(fim)) return res.status(400).json({ erro: 'Use o formato de tempo certo, tipo 4:32 ou 1:04:10.' });
  if (!['original', 'centro_blur', 'crop', 'talking_texto'].includes(formato)) return res.status(400).json({ erro: 'Formato invalido.' });

  const si = paraSegundos(inicio), sf = paraSegundos(fim);
  if (isNaN(si) || isNaN(sf) || sf <= si) return res.status(400).json({ erro: 'O fim precisa ser depois do inicio.' });
  if (sf - si > MAX_SEGUNDOS) return res.status(400).json({ erro: 'O corte ta muito longo (maximo 60 minutos por vez).' });

  let pasta;
  try {
    await garantirYtdlp();
    await garantirFfmpeg();
    if (formato === 'talking_texto' && texto) await garantirFonte();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    limparCacheAntigo();
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corte-'));
    const fullPath = cachePathPara(url, 'mp4');
    const cortePath = path.join(pasta, 'corte.mp4');
    const duracao = sf - si;
    const cacheHit = fs.existsSync(fullPath) && (() => { try { return fs.statSync(fullPath).size > 1024 * 1024; } catch (e) { return false; } })();

    if (cacheHit) {
      console.log('[cortador] CACHE HIT - usando video ja baixado:', path.basename(fullPath));
    } else {
      const t1 = Date.now();
      console.log('[cortador] CACHE MISS - baixando do YouTube | proxy:', PROXY_URL ? 'sim' : 'nao');
      const r1 = await executar(YTDLP, [
        '--no-playlist', '--no-warnings', '--no-progress',
        '--extractor-args', 'youtube:player_client=tv,web_safari,default',
        ...(cookiesOk ? ['--cookies', COOKIES_PATH] : []),
        ...(PROXY_URL ? ['--proxy', PROXY_URL] : []),
        '--ffmpeg-location', FFMPEG,
        '-N', '4',
        '-f', 'bv*[vcodec^=avc1][height<=720][fps<=30]+ba[ext=m4a]/bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/b[ext=mp4]/b',
        '--merge-output-format', 'mp4',
        '-o', fullPath,
        url,
      ], 'yt-dlp-download');
      const dt1 = ((Date.now() - t1) / 1000).toFixed(1);
      console.log('[cortador] download levou', dt1, 's');

      if (r1.codigo !== 0 || !fs.existsSync(fullPath)) {
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
        limpar(pasta);
        return res.status(500).json({ erro: 'Nao consegui baixar esse video. Confere o link.', detalhe: (r1.stderr || r1.stdout || 'sem detalhes').slice(-600) });
      }
    }

    const t2 = Date.now();
    console.log('[cortador] cortando | formato', formato, '| inicio', si, 's | duracao', duracao, 's');

    let cutArgs;
    if (formato === 'original') {
      // -c copy: cut rapido sem reencode (segundos)
      cutArgs = [
        '-y',
        '-ss', String(si),
        '-i', fullPath,
        '-t', String(duracao),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        cortePath,
      ];
    } else {
      // Formatos verticais: reencode com filtro
      let filtroV;
      if (formato === 'centro_blur') {
        // Vídeo no centro com fundo desfocado
        filtroV = 'split=2[a][b];[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:1[bg];[b]scale=720:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
      } else if (formato === 'crop') {
        // Crop central, zoom no meio
        filtroV = 'crop=ih*9/16:ih,scale=720:1280';
      } else { // talking_texto
        // Se nao tem texto, vira so um crop vertical limpo (sem subtitles filter)
        if (!texto) {
          filtroV = 'crop=ih*9/16:ih,scale=720:1280';
        } else {
          // Crop + texto via subtitles ASS (drawtext nao disponivel no build do ffmpeg)
          // libass renderiza com fontes apontadas via fontsdir
          const assPath = path.join(pasta, 'texto.ass');
          const textoUp = texto.toUpperCase().replace(/[\\{}]/g, '');
          const assConteudo = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Anton,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,4,1,2,30,30,140,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,${textoUp}
`;
          fs.writeFileSync(assPath, assConteudo);
          const assPathEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:').replace(/,/g, '\\,');
          const fontsDir = path.dirname(FONTE);
          filtroV = `crop=ih*9/16:ih,scale=720:1280,subtitles='${assPathEscaped}':fontsdir='${fontsDir}'`;
        }
      }
      cutArgs = [
        '-y',
        '-ss', String(si),
        '-i', fullPath,
        '-t', String(duracao),
        '-vf', filtroV,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        cortePath,
      ];
    }

    const r2 = await executar(FFMPEG, cutArgs, 'ffmpeg-cut');
    const dt2 = ((Date.now() - t2) / 1000).toFixed(1);
    console.log('[cortador] cut levou', dt2, 's | cache:', cacheHit ? 'HIT' : 'MISS', '| formato:', formato);

    if (r2.codigo !== 0 || !fs.existsSync(cortePath)) {
      limpar(pasta);
      return res.status(500).json({ erro: 'Baixei o video mas nao consegui cortar.', detalhe: (r2.stderr || 'sem detalhes').slice(-600) });
    }

    res.download(cortePath, `corte_${inicio.replace(/:/g, '-')}_a_${fim.replace(/:/g, '-')}.mp4`, () => limpar(pasta));
  } catch (e) {
    if (pasta) limpar(pasta);
    res.status(500).json({ erro: 'Deu um erro no servidor.', detalhe: String(e.message || e) });
  }
});

function limpar(pasta) { try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (e) {} }

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log('Cortador rodando na porta ' + PORTA));
