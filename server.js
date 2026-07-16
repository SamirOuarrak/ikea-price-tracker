// server.js — API + planification du scraping quotidien + sert le frontend

const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const { runFullScrape } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Liste des produits (avec pagination simple + recherche)
app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const rows = q
    ? db
        .prepare(
          `SELECT * FROM products WHERE is_active=1 AND name LIKE ? ORDER BY last_checked_at DESC LIMIT ? OFFSET ?`
        )
        .all(`%${q}%`, limit, offset)
    : db
        .prepare(`SELECT * FROM products WHERE is_active=1 ORDER BY last_checked_at DESC LIMIT ? OFFSET ?`)
        .all(limit, offset);

  res.json(rows);
});

// Historique de prix d'un produit précis
app.get('/api/products/:articleNumber/history', (req, res) => {
  const rows = db
    .prepare(`SELECT price, currency, checked_at FROM price_history WHERE article_number=? ORDER BY checked_at ASC`)
    .all(req.params.articleNumber);
  res.json(rows);
});

// Produits ajoutés récemment (nouveautés IKEA détectées par le crawler)
app.get('/api/products/new', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db
    .prepare(
      `SELECT * FROM products WHERE is_active=1 AND first_seen_at >= datetime('now', ?) ORDER BY first_seen_at DESC`
    )
    .all(`-${days} days`);
  res.json(rows);
});

// Produits dont le prix a changé récemment
app.get('/api/products/price-drops', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const rows = db
    .prepare(
      `SELECT p.article_number, p.name, p.slug_url, p.current_price, p.currency,
              (SELECT price FROM price_history ph
               WHERE ph.article_number = p.article_number AND ph.checked_at < datetime('now', ?)
               ORDER BY ph.checked_at DESC LIMIT 1) AS previous_price
       FROM products p WHERE p.is_active = 1`
    )
    .all(`-${days} days`)
    .filter((r) => r.previous_price !== null && r.previous_price !== r.current_price);
  res.json(rows);
});

// Historique des runs de scraping (pour surveiller que le cron tourne bien)
app.get('/api/scrape-runs', (req, res) => {
  res.json(db.prepare(`SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 20`).all());
});

// Déclenchement manuel (utile pour tester sans attendre le cron)
app.post('/api/scrape/run-now', async (req, res) => {
  res.json({ status: 'started' });
  try {
    await runFullScrape();
  } catch (err) {
    console.error('Erreur pendant le scrape manuel:', err.message);
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

// Diagnostic : teste un seul appel réseau vers IKEA pour voir si le serveur est bloqué
app.get('/api/debug/test-fetch', async (req, res) => {
  const axios = require('axios');
  const start = Date.now();
  try {
    const response = await axios.get('https://www.ikea.com/ma/fr/cat/products-products/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'fr-MA,fr;q=0.9',
      },
    });
    res.json({
      success: true,
      status: response.status,
      durationMs: Date.now() - start,
      contentLength: response.data.length,
      preview: response.data.slice(0, 300),
    });
  } catch (err) {
    res.json({
      success: false,
      durationMs: Date.now() - start,
      errorCode: err.code || null,
      errorMessage: err.message,
      responseStatus: err.response ? err.response.status : null,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`IKEA price tracker en écoute sur 0.0.0.0:${PORT}`);
});

// Planification: tous les jours à 6h00 (heure du serveur)
cron.schedule('0 6 * * *', async () => {
  console.log('Cron: démarrage du scraping quotidien');
  try {
    await runFullScrape();
  } catch (err) {
    console.error('Cron: erreur pendant le scraping:', err.message);
  }
});
