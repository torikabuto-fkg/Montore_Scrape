const fetch = require('node-fetch');
const cheerio = require('cheerio');
const pdfMake = require('pdfmake/build/pdfmake');
const vfsFonts = require('./build/vfs_fonts.js');
const { CookieJar } = require('tough-cookie');
const fetchCookie = require('fetch-cookie');
const fs = require('fs');
const path = require('path');

// vfs登録（PDFMake用フォントファイルの仮想ファイルシステム）
pdfMake.vfs = vfsFonts.pdfMake.vfs;

// フォント設定（例：日本語用フォント NotoSansJP を利用）
const fonts = {
  Roboto: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  },
  NotoSansJP: {
    normal: 'NotoSansJP-Regular.ttf',
    bold: 'NotoSansJP-Bold.ttf'
  }
};
pdfMake.fonts = fonts;

/**
 * ログイン処理  
 * ログインページからCSRFトークンを取得し、POST送信でログインを実施。  
 * 成功すればCookie付きのfetch関数（jarredFetch）を返します。
 */
async function login(loginUrl, email, password) {
  const cookieJar = new CookieJar();
  const jarredFetch = fetchCookie(fetch, cookieJar);
  try {
    // CSRFトークンを取得するためログインページにアクセス
    const loginPageResponse = await jarredFetch(loginUrl);
    if (!loginPageResponse.ok) {
      throw new Error(`ログインページへのアクセス失敗: ${loginPageResponse.status}`);
    }
    const loginPageHtml = await loginPageResponse.text();
    const $ = cheerio.load(loginPageHtml);
    const csrfToken = $('input[name="authenticity_token"]').val();
    if (!csrfToken) {
      throw new Error("CSRFトークンが取得できませんでした");
    }

    // ログインフォームの送信データを用意
    const formData = new URLSearchParams();
    formData.append('authenticity_token', csrfToken);
    formData.append('user[email]', email);
    formData.append('user[password]', password);

    const postResponse = await jarredFetch(loginUrl, {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      redirect: 'manual'
    });

    if (postResponse.status === 302 || postResponse.status === 303) {
      const redirectLocation = postResponse.headers.get('Location');
      console.log(`ログイン成功。リダイレクト先: ${redirectLocation}`);
      return jarredFetch;
    } else {
      throw new Error(`ログイン失敗: ステータスコード ${postResponse.status}`);
    }
  } catch (error) {
    console.error("ログイン処理エラー:", error);
    return null;
  }
}


/**
 * 問題ページのスクレイピング  
 * ※【問題部分】はページ上部のHTML（＜div class="is-submit">より前）から  
 * ・問題番号  
 * ・問題文  
 * ・（存在すれば）問題画像（複数可）  
 * ・選択肢（複数）  
 * を抽出します。  
 *
 * また、【解説部分】（＜div class="d-issue__expound">以降）の中から  
 * ・（存在すれば）解説画像（複数可）  
 * ・選択肢考察（テキスト）  
 * ・正解  
 * ・ポイント  
 * を抽出します。  
 *
 * さらに、「スキップして次へ」のアンカーのhrefから次の問題ページURLを取得します。
 */
/**
 * 問題ページのスクレイピング  
 * jarredFetchを引数として受け取るように変更
 */
async function scrapeProblemContent(problemUrl, jarredFetch) {
    try {
      const response = await jarredFetch(problemUrl); // jarredFetchを利用してリクエスト
      if (!response.ok) {
        throw new Error(`HTTPエラー: ${response.status}`);
      }
      const html = await response.text();
      const $ = cheerio.load(html);
  
      // ---【問題部分】の抽出---
      let problemNumber = $('.d-issue__content__num p').text().replace('問題番号 :', '').trim();
      if (!problemNumber) { problemNumber = '取得失敗'; }
  
      let questionText = $('#question-body p').text().trim();
      if (!questionText) { questionText = '取得失敗'; }
  
      const problemImageSrcs = [];
      $('#question-body').parent().find('img').each((i, el) => {
        let src = $(el).attr('src');
        if (src) {
          if (src.startsWith('//')) {
            src = 'https:' + src;
          } else if (!src.startsWith('http')) {
            src = new URL(src, problemUrl).href;
          }
          if (!problemImageSrcs.includes(src)) {
            problemImageSrcs.push(src);
          }
        }
      });
  
      const choices = [];
      $('#practice_question_choice li button').each((i, el) => {
        choices.push($(el).text().trim());
      });

  
      // ---【解説部分】の抽出---
      let explanation = null;
      const expContainer = $('.d-issue__expound .d-issue__expound__accordion_content');
      if (expContainer.length > 0) {
        const explanationImageSrcs = [];
        expContainer.find('img').each((i, el) => {
          let src = $(el).attr('src');
          if (src) {
            if (src.startsWith('//')) {
              src = 'https:' + src;
            } else if (!src.startsWith('http')) {
              src = new URL(src, problemUrl).href;
            }
            if (!explanationImageSrcs.includes(src)) {
              explanationImageSrcs.push(src);
            }
          }
        });
  
        const expHtml = $('#question-explanation').html() || '';
        let analysisText = '取得失敗';
        let correctAnswer = '';
        let pointsText = '';
  
        const expHtmlNoLF = expHtml.replace(/\n/g, '');
        const analysisMatch = expHtmlNoLF.match(/<b><u>選択肢考察<\/u><\/b>[:：]?([\s\S]*?)<b><u>正解<\/u><\/b>/);
        if (analysisMatch && analysisMatch[1]) {
          analysisText = analysisMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
        }
        const correctMatch = expHtmlNoLF.match(/<b><u>正解<\/u><\/b>[:：]?\s*([A-E○×]+)/);
        if (correctMatch && correctMatch[1]) {
          correctAnswer = correctMatch[1].trim();
        }
        const pointsMatch = expHtmlNoLF.match(/<b><u>ポイント<\/u><\/b>[:：]?([\s\S]*)$/);
        if (pointsMatch && pointsMatch[1]) {
          pointsText = pointsMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
        }
  
        explanation = {
          explanationImageSrcs,
          analysisText,
          correctAnswer,
          pointsText
        };
      }

    // ★【次の問題URL】（「スキップして次へ」ボタンのhref属性）
    // 例：href="/users/cbt/practice_questions/223783150#26248" → 完全なURLに書き換え
    let nextHref = $('a.o-btn.is-grey.is-triangle_g').attr('href');
    let nextUrl = '';
    if (nextHref) {
      if (!nextHref.startsWith('http')) {
        nextUrl = 'https://m3e-medical.com' + nextHref;
      } else {
        nextUrl = nextHref;
      }
    }
  
      
      return {
        problemNumber,
        questionText,
        problemImageSrcs,
        choices,
        explanation,
        nextUrl
      };
    } catch (error) {
      console.error("スクレイピングエラー:", error);
      return null;
    }
  }
  

// ===============================
// 【ヘルパー関数】
// 1. fetchImageDataUrl(src)
// 　URL（またはすでにdata URLの場合）から画像データを取得し、Base64のdata URLとして返す
async function fetchImageDataUrl(src) {
  if (src.startsWith('data:')) {
    return src;
  }
  try {
    const response = await fetch(src);
    if (!response.ok) {
      console.error("Fetch error for image:", src, response.status);
      return null;
    }
    const buffer = await response.buffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.error("Error fetching image:", src, error);
    return null;
  }
}

// 2. buildImageTable(imageSrcArray, defaultFixedWidth)
//    複数枚の画像がある場合、最大3枚／行のグリッドテーブルを作成する。
//    ・画像が1枚の場合は、単体用にdefaultFixedWidth（例：200 or 150）を使用。
//    ・複数枚の場合は、各行は必ず3セルとなるようにし、足りない場合は空セルでパディング。
//    ・各セルの幅は、A4用紙の左右マージン除く利用可能横幅（availableWidth）を3で割った値となります。
async function buildImageTable(imageSrcArray, defaultFixedWidth) {
  // 利用可能横幅（例：A4用紙の左右マージン40ptずつ除く＝約515.28pt）
  const availableWidth = 515.28;
  const maxCols = 3; // 固定：1行に3セル

  if (!imageSrcArray || imageSrcArray.length === 0) return null;
  if (imageSrcArray.length === 1) {
    // 1枚の場合は単体表示
    const dataUrl = await fetchImageDataUrl(imageSrcArray[0]);
    if (!dataUrl) return null;
    return [[{ image: dataUrl, width: defaultFixedWidth, margin: [0, 5, 0, 5] }]];
  } else {
    const rows = [];
    for (let i = 0; i < imageSrcArray.length; i += maxCols) {
      const rowSrcs = imageSrcArray.slice(i, i + maxCols);
      const row = [];
      // 各セルの幅を固定：利用可能横幅を3で割った値
      const cellWidth = availableWidth / maxCols;
      for (const src of rowSrcs) {
        const dataUrl = await fetchImageDataUrl(src);
        if (dataUrl) {
          row.push({ image: dataUrl, width: cellWidth, margin: [0, 5, 0, 5] });
        } else {
          row.push({ text: "画像読み込みエラー", style: 'error' });
        }
      }
      // 行のセル数がmaxColsに満たない場合は空セルでパディング
      while (row.length < maxCols) {
        row.push({ text: "" });
      }
      rows.push(row);
    }
    return rows;
  }
}

// ===============================
// 【generatePdf関数】
// Montore_Scrape.js のスクレイピング結果（contents）を受け取り、
// 各問題ページ（【問題部分】と【解説部分】）を新規ページとしてPDFに配置します。
async function generatePdf(contents, fileName) {
  const documentDefinition = {
    content: [],
    defaultStyle: { font: 'NotoSansJP' },
    styles: {
      header: { fontSize: 10, bold: true, margin: [0, 0, 0, 10] },
      question: { fontSize: 14, margin: [0, 5, 0, 5] },
      choices: { fontSize: 14, margin: [15, 2, 0, 2] },
      explanationHeader: { fontSize: 14, bold: true, margin: [0, 15, 0, 5] },
      analysis: { fontSize: 12, margin: [15, 0, 0, 5] },
      correctAnswer: { fontSize: 12, bold: true, margin: [0, 5, 0, 5] },
      points: { fontSize: 12, margin: [15, 0, 0, 15] },
      error: { fontSize: 10, color: 'red', margin: [0, 5, 0, 5] }
    }
  };

  for (const content of contents) {
    // ---【問題ページ】---
    documentDefinition.content.push(
      { text: `問題番号: ${content.problemNumber}`, style: 'header' },
      { text: content.questionText, style: 'question' }
    );

    // 問題画像：もし存在すれば、buildImageTable() を使ってレイアウト
    if (content.problemImageSrcs && content.problemImageSrcs.length > 0) {
      const tableBody = await buildImageTable(content.problemImageSrcs, 200);
      if (tableBody) {
        documentDefinition.content.push({
          table: {
            widths: tableBody[0].map(() => '*'),
            body: tableBody
          },
          layout: 'noBorders',
          margin: [0, 5, 0, 5]
        });
      } else {
        documentDefinition.content.push({ text: "問題画像読み込みエラー", style: 'error' });
      }
    }

    // 選択肢
    if (content.choices && content.choices.length > 0) {
      documentDefinition.content.push({
        ul: content.choices,
        style: 'choices'
      });
    }
    // ページ改行（問題ページ終了）
    documentDefinition.content.push({ text: '', pageBreak: 'after' });

    // ---【解説ページ】---
    if (content.explanation) {
      documentDefinition.content.push({ text: "解説", style: 'explanationHeader' });
      // 解説画像：buildImageTable() を利用（解説画像は単体の場合は150pt固定）
      if (content.explanation.explanationImageSrcs && content.explanation.explanationImageSrcs.length > 0) {
        const tableBody = await buildImageTable(content.explanation.explanationImageSrcs, 150);
        if (tableBody) {
          documentDefinition.content.push({
            table: {
              widths: tableBody[0].map(() => '*'),
              body: tableBody
            },
            layout: 'noBorders',
            margin: [0, 5, 0, 5]
          });
        } else {
          documentDefinition.content.push({ text: "解説画像読み込みエラー", style: 'error' });
        }
      }
      // 解説テキスト群
      documentDefinition.content.push({ text: "選択肢考察", style: 'explanationHeader' });
      documentDefinition.content.push({ text: content.explanation.analysisText, style: 'analysis' });
      if (content.explanation.correctAnswer && content.explanation.correctAnswer.trim() !== '') {
        documentDefinition.content.push({ text: "正解", style: 'explanationHeader' });
        documentDefinition.content.push({ text: content.explanation.correctAnswer, style: 'correctAnswer' });
      }
      if (content.explanation.pointsText && content.explanation.pointsText.trim() !== '') {
        documentDefinition.content.push({ text: "ポイント", style: 'explanationHeader' });
        documentDefinition.content.push({ text: content.explanation.pointsText, style: 'points' });
      }
      // 改ページ（解説ページ終了）
      documentDefinition.content.push({ text: '', pageBreak: 'after' });
    }
  }

  try {
    const extension = "pdf";
    const pdfDoc = pdfMake.createPdf(documentDefinition);
    pdfDoc.getBuffer((buffer) => {
      fs.writeFileSync(`${fileName}.${extension}`, buffer);
      console.log("PDFファイルが生成されました。");
    });
  } catch (error) {
    console.error("PDF生成エラー:", error);
  }
}



/**
 * メイン処理  
 * ① ログイン → ② 指定件数分（例：5問）の問題ページをスクレイピングし、  
 * ③ 各ページの【問題パート】と【解説パート】をPDFに配置する。
 */
async function main() {
    // ■ 設定値（必要に応じて書き換えてください）
    const loginUrl = 'https://m3e-medical.com/users/sign_in';   // ログインページのURL
    const email = '';             // ログイン用メールアドレス
    const password = '';                   // ログイン用パスワード
    const fileName = "細胞生物学";//科目名（保存したいファイル名）
    const startUrl = 'https://m3e-medical.com/users/cbt/practice_questions/223927669#25395';  // 最初の問題ページURL（適宜更新）
    const numberOfPages = 26;  // 連続してスクレイピングする問題数
  
    // ■ ログイン処理
    const jarredFetch = await login(loginUrl, email, password);
    if (!jarredFetch) {
      console.error("ログインに失敗しました。処理を終了します。");
      return;
    }
  
    // ■ 連続スクレイピング処理
    let currentUrl = startUrl;
    let contents = [];
    for (let i = 0; i < numberOfPages; i++) {
      console.log(`問題${i + 1}をスクレイピング中…`);
      const pageContent = await scrapeProblemContent(currentUrl, jarredFetch);
      if (!pageContent) {
        console.error(`問題${i + 1}のスクレイピングに失敗しました。`);
        break;
      }
      contents.push(pageContent);
  
      // 次の問題URLが取得できなかった場合はループ終了
      if (!pageContent.nextUrl) {
        console.log("次の問題URLが見つかりませんでした。終了します。");
        break;
      }
      currentUrl = pageContent.nextUrl;
    }
  
    // ■ PDF生成処理
    await generatePdf(contents, fileName); 

}
  // 実行
  main();
  

