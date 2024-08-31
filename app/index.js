const { chromium } = require('playwright');
const fs = require('fs');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const processBody = (body, link, resource = 'NPR') => {
    let formattedBody = '';
  
    if (body !== null) {
      formattedBody += `<p>${body}</p><br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
    }
  
    if (link && !body) {
      formattedBody += `<br><br><ul><li><a href='${link}'>Visit article @ ${resource}</a></li></ul>`;
    } else if (!link && !body) {
      formattedBody = '';
    }
  
    return formattedBody;
  };

(async () => {
  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING,
  });

  console.log('Connecting to the database...');
  try {
    await client.connect();
    console.log('Connected to the database successfully.');

    await client.query('DELETE FROM "Article" WHERE resource = $1', ['NPR']);
    console.log('Truncated existing articles with resource "NPR".');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    console.log('Navigating to NPR News section...');
    try {
      await page.goto('https://www.npr.org/sections/news/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      console.log('Page loaded successfully');
    } catch (error) {
      console.error('Failed to load NPR News page:', error);
      await browser.close();
      await client.end();
      return;
    }

    // Scrape the articles
    const articles = await page.$$eval('.item', items =>
      items.map(item => {
        const headline = item.querySelector('.title a')?.innerText.trim();
        const link = item.querySelector('.title a')?.href.trim();
        const imageUrl = item.querySelector('.item-image img')?.src || '';
        const date = item.querySelector('.teaser time')?.getAttribute('datetime').trim();
        const slug = headline.split(' ').slice(0, 3).join('').toLowerCase().replace(/[^a-z]/g, '');
        return { headline, link, imageUrl, date, slug };
      })
    );

    console.log('Collected headlines and links:', articles);

    for (const article of articles) {
      console.log(`Visiting article: ${article.headline}`);

      let success = false;
      let attempts = 0;
      const maxAttempts = 3;

      while (!success && attempts < maxAttempts) {
        attempts++;
        try {
          await page.goto(article.link, {
            waitUntil: 'domcontentloaded',
            timeout: 6000,
          });

          try {
            const bodyContent = await page.$$eval('#storytext p', paragraphs =>
              paragraphs.map(p => p.innerText.trim()).join('\n\n')
            );

            article.summary =
              bodyContent.split(' ').slice(0, 25).join(' ') + '...';
            article.body = processBody(bodyContent, article.link);
          } catch (err) {
            console.error('Error finding body content: ', err);
            article.summary = '';
            article.body = '';
          }


          article.author = 'NPR'; // Default author if not found
          article.id = cuid();

          // Insert article into the database
          await client.query(
            `INSERT INTO "Article" (id, slug, headline, summary, body, author, resource, media, link, date) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              article.id,
              article.slug,
              article.headline,
              article.summary || '',
              article.body || '',
              article.author,
              'NPR',
              article.imageUrl,
              article.link,
              new Date(article.date).toISOString(),
            ]
          );

          success = true;
          console.log(`Collected and saved data for article: ${article.headline}`);
        } catch (error) {
          console.error(`Error processing article: ${article.headline}, attempt ${attempts}`, error);
          if (attempts >= maxAttempts) {
            console.error(`Failed to load article after ${maxAttempts} attempts.`);
          }
        }
      }
    }

    fs.writeFileSync('npr-news-articles.json', JSON.stringify(articles, null, 2));
    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
})();
