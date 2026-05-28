// ============================================================
//  CORTADOR - serviço isolado (NÃO mexe na Clara)
//  Recebe: link do YouTube + de tal minuto + até tal minuto
//  Devolve: o arquivo de vídeo só daquele trecho, pra baixar
// ============================================================

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// Onde o programa que baixa do YouTube (yt-dlp) vai ficar guardado
const YTDLP = path.join(os.tmpdir(), 'yt-dlp');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// Limite de segurança: no máximo 15 min por corte (evita abuso e download gigante)
const MAX_SEGUNDOS = 15 * 60;

// ---- Baixa o yt-dlp na primeira vez que precisar (e guarda) ----
let prontoYtdlp = null;
function garantirYtdlp() {
  if (prontoYtdlp) return prontoYtdlp;
  prontoYtdlp = new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP)) { try { fs.chmodSync(YTDLP, 0o755); } catch (e) {} return resolve(); }
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Não consegui baixar o yt-dlp (' + r.statusCode + ')'));
        const arq = fs.createWriteStream(YTDLP);
        r.pipe(arq);
        arq.on('finish', () => arq.close(() => { fs.chmodSync(YTDLP, 0o755); resolve(); }));
      }).on('error', reject);
    };
    baixar(YTDLP_URL);
  });
  return prontoYtdlp;
}

// ---- Validações ----
function linkValido(u) {
  return typeof u === 'string' &&
    /^https:\/\/(www\.|m\.)?(youtube\.com\/|youtu\.be\/)/.test(u.trim());
}
function tempoValido(t) {
  return typeof t === 'string' && /^(\d{1,2}:)?\d{1,2}:\d{2}$|^\d{1,3}(:\d{2}){0,2}$|^\d+$/.test(t.trim());
}
function paraSegundos(t) {
  const p = String(t).trim().split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

// ---- Saúde do serviço ----
app.get('/', (_req, res) => res.json({ ok: true, servico: 'cortador', versao: 2 }));

// ---- O corte de verdade ----
app.post('/cortar', async (req, res) => {
  const url = (req.body.url || '').trim();
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();

  if (!linkValido(url)) return res.status(400).json({ erro: 'Cole um link válido do YouTube.' });
  if (!tempoValido(inicio) || !tempoValido(fim)) return res.status(400).json({ erro: 'Use o formato de tempo certo, tipo 4:32 ou 1:04:10.' });

  const si = paraSegundos(inicio), sf = paraSegundos(fim);
  if (isNaN(si) || isNaN(sf) || sf <= si) return res.status(400).json({ erro: 'O fim precisa ser depois do início.' });
  if (sf - si > MAX_SEGUNDOS) return res.status(400).json({ erro: 'O corte tá muito longo (máximo 15 minutos por vez).' });

  let pasta;
  try {
    await garantirYtdlp();
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corte-'));
    const secao = `*${inicio}-${fim}`;
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--extractor-args', 'youtube:player_client=tv,web_safari,default',
      '-f', 'bv*+ba/b',
      '--download-sections', secao,
      '--force-keyframes-at-cuts',
      '--merge-output-format', 'mp4',
      '-o', path.join(pasta, 'corte.%(ext)s'),
      url,
    ];

    console.log('[cortador] rodando yt-dlp | trecho', secao, '| url', url);
    const proc = spawn(YTDLP, args);
    let erroSaida = '';
    proc.stderr.on('data', d => { erroSaida += d.toString(); });
    proc.stdout.on('data', d => { erroSaida += d.toString(); });

    proc.on('close', (codigo) => {
      console.log('[cortador] yt-dlp terminou com codigo', codigo);
      if (erroSaida) console.log('[cortador] saida do yt-dlp:\n' + erroSaida.slice(-1500));
      if (codigo !== 0) {
        limpar(pasta);
        return res.status(500).json({ erro: 'Não rolou baixar esse trecho. Confere o link e os tempos.', detalhe: (erroSaida || 'sem detalhes').slice(-600) });
      }
      const arquivos = fs.readdirSync(pasta).filter(f => f.startsWith('corte'));
      if (!arquivos.length) { limpar(pasta); return res.status(500).json({ erro: 'O corte não foi gerado. Tenta de novo.' }); }
      const caminho = path.join(pasta, arquivos[0]);
      res.download(caminho, `corte_${inicio.replace(/:/g, '-')}_a_${fim.replace(/:/g, '-')}.mp4`, () => limpar(pasta));
    });
  } catch (e) {
    if (pasta) limpar(pasta);
    res.status(500).json({ erro: 'Deu um erro no servidor.', detalhe: String(e.message || e) });
  }
});

function limpar(pasta) { try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (e) {} }

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log('Cortador rodando na porta ' + PORTA));
