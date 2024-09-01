const { chromium } = require('playwright');
const fs = require('fs');
const { Client } = require('pg');
const cuid = require('cuid');
require('dotenv').config();

const processBody = (body, link, resource = 'NPR') => {
  let formattedBody = '';

  if (body) {
    formattedBody += `<p>${body}</p><br><br><ul><li><a href='${link}'>Visit ${resource}</a></li></ul>`;
  } else if (link) {
    formattedBody += `<br><br><ul><li><a href='${link}'>Visit article @ ${resource}</a></li></ul>`;
  }

  return formattedBody;
};

const insertArticleIntoDatabase = async (client, article) => {
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
      article.resource,
      article.media,
      article.link,
      new Date(article.date).toISOString()
    ]
  );
};

(async () => {
  const client = new Client({
    connectionString: process.env.POSTGRES_CONNECTION_STRING
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
        timeout: 6000
      });
      console.log('Page loaded successfully');
    } catch (error) {
      console.error('Failed to load NPR News page:', error);
      await browser.close();
      await client.end();
      return;
    }

    // Scrape the articles
    const articlesData = await page.$$eval('.item', items =>
      items.map(item => ({
        headline: item.querySelector('.title a')?.innerText.trim(),
        link: item.querySelector('.title a')?.href.trim(),
        date: item.querySelector('.teaser time')?.getAttribute('datetime').trim()
      }))
    );

    const articles = articlesData.map(data => ({
      id: cuid(),
      headline: data.headline,
      link: data.link,
      date: data.date,
      slug: data.headline.split(' ').slice(0, 3).join('').toLowerCase().replace(/[^a-z]/g, ''),
      resource: 'NPR',
      summary: '',
      body: '',
      author: '',
      media: ''
    }));

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
            timeout: 6000
          });

          try {
            const media = await page.$eval(
              'div.imagewrap.has-source-dimensions picture img',
              img => img.getAttribute('src')
            );
            article.media = media;
          } catch (error) {
            console.error('Error finding media content: ', error);
            article.media = '';
          }

          try {
            const bodyContent = await page.$$eval('#storytext p', paragraphs =>
              paragraphs.map(p => p.innerText.trim()).join('\n\n')
            );

            article.summary = bodyContent.split(' ').slice(0, 25).join(' ') + '...';
            article.body = processBody(bodyContent, article.link);
          } catch (err) {
            console.error('Error finding body content: ', err);
            article.summary = '';
            article.body = '';
          }

          try {
            const author = await page.$eval('.byline__name a', name =>
              name.innerText.trim()
            );
            article.author = author;
          } catch (err) {
            try {
              const author = await page.$eval(
                '.byline__name.byline__name--block',
                name => name.innerText.trim()
              );
              article.author = author;
            } catch (err) {
              try {
                const author = await page.$eval('.byline__name', element =>
                  element.innerText.trim()
                );
                article.author = author;
              } catch (err) {
                console.error('Error finding author: ', err);
                article.author = 'See article for details';
              }
            }
          }

          await insertArticleIntoDatabase(client, article);

          success = true;
          console.log(`Collected and saved data for article: ${article.headline}`);
        } catch (error) {
          console.error(
            `Error processing article: ${article.headline}, attempt ${attempts}`,
            error
          );
          if (attempts >= maxAttempts) {
            console.error(`Failed to load article after ${maxAttempts} attempts.`);
          }
        }
      }
    }

    fs.writeFileSync(
      'npr-news-articles.json',
      JSON.stringify(articles, null, 2)
    );
    await browser.close();
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
})();
