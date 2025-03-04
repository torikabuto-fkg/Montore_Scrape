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
    const formData = new URLSearchParams();
    formData.append('authenticity_token', csrfToken);
    formData.append('user[email]', email);
    formData.append('user[password]', password);
    const postResponse = await jarredFetch(loginUrl, {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
 * 【問題部分】から問題番号、問題文、問題画像、選択肢を、  
 * 【解説部分】から解説画像、選択肢考察、正解、ポイントを抽出します。  
 * また、「スキップして次へ」のリンクから次のページURLを取得します。  
 * さらに、【基本事項】（HTML例：#accordion_expound_base 内の.marker_basic）を抽出します。
 */
async function scrapeProblemContent(problemUrl, jarredFetch) {
  try {
    const response = await jarredFetch(problemUrl);
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
      // 画像抽出時、基本情報領域内の画像は除外する
      expContainer.find('img').each((i, el) => {
        // チェック：この画像が基本情報のコンテナ内にある場合はスキップ
        if ($(el).closest('#accordion_expound_base').length > 0 || $(el).closest('.marker_basic').length > 0) {
          return;
        }
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

    // ★【次の問題URL】の取得
    let nextHref = $('a.o-btn.is-grey.is-triangle_g').attr('href');
    let nextUrl = '';
    if (nextHref) {
      if (!nextHref.startsWith('http')) {
        nextUrl = 'https://m3e-medical.com' + nextHref;
      } else {
        nextUrl = nextHref;
      }
    }

    // ---【基本事項】の抽出---
    // 基本事項は、HTML例として<div id="accordion_expound_base">以下の.marker_basic内に記述されている
    let basic = null;
    const basicElem = $('#accordion_expound_base');
    if (basicElem.length > 0) {
      const marker = basicElem.find('.marker_basic .d-issue__expound__box');
      if (marker.length > 0) {
        const basicTitle = marker.find('h3').text().trim();
        const basicImageSrcs = [];
        marker.find('.js-lightgallery img').each((i, el) => {
          let src = $(el).attr('src');
          if (src) {
            if (src.startsWith('//')) {
              src = 'https:' + src;
            } else if (!src.startsWith('http')) {
              src = new URL(src, problemUrl).href;
            }
            if (!basicImageSrcs.includes(src)) {
              basicImageSrcs.push(src);
            }
          }
        });
        let basicText = marker.find('p').html() || '';
        basicText = basicText.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
        basic = {
          title: basicTitle,
          textContent: basicText,
          images: basicImageSrcs
        };
      }
    }

    return {
      problemNumber,
      questionText,
      problemImageSrcs,
      choices,
      explanation,
      nextUrl,
      basic
    };
  } catch (error) {
    console.error("スクレイピングエラー:", error);
    return null;
  }
}


/**
 * ヘルパー関数：URLまたはdata URLから画像を取得し、Base64のdata URLとして返す
 */
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

/**
 * 複数枚の画像がある場合、最大3枚／行のグリッドテーブルを作成する。
 * ・画像が1枚の場合は、単体用にdefaultFixedWidthを使用。
 * ・複数枚の場合は、各行は必ず3セルとなるようにし、足りない場合は空セルでパディング。
 */
async function buildImageTable(imageSrcArray, defaultFixedWidth) {
  const availableWidth = 515.28;
  const maxCols = 3;
  if (!imageSrcArray || imageSrcArray.length === 0) return null;
  if (imageSrcArray.length === 1) {
    const dataUrl = await fetchImageDataUrl(imageSrcArray[0]);
    if (!dataUrl) return null;
    return [[{ image: dataUrl, width: defaultFixedWidth, margin: [0, 5, 0, 5] }]];
  } else {
    const rows = [];
    for (let i = 0; i < imageSrcArray.length; i += maxCols) {
      const rowSrcs = imageSrcArray.slice(i, i + maxCols);
      const row = [];
      const cellWidth = availableWidth / maxCols;
      for (const src of rowSrcs) {
        const dataUrl = await fetchImageDataUrl(src);
        if (dataUrl) {
          row.push({ image: dataUrl, width: cellWidth, margin: [0, 5, 0, 5] });
        } else {
          row.push({ text: "画像読み込みエラー", style: 'error' });
        }
      }
      while (row.length < maxCols) {
        row.push({ text: "" });
      }
      rows.push(row);
    }
    return rows;
  }
}

/**
 * PDF生成関数  
 * contentsは各問題・解説データ（さらにbasic情報を含む）の配列  
 * 各問題ページ（【問題部分】）と解説ページ（【解説部分】＋【基本事項】）をPDFに配置します。
 */
async function generatePdf(contents, fileName) {
  const documentDefinition = {
    content: [],
    defaultStyle: { font: 'NotoSansJP' },
    styles: {
      header: { fontSize: 12, bold: true, margin: [0, 0, 0, 10] },
      question: { fontSize: 10.5, margin: [0, 5, 0, 5] },
      choices: { fontSize: 10.5, margin: [15, 2, 0, 2] },
      explanationHeader: { fontSize: 12, bold: true, margin: [0, 15, 0, 5] },
      analysis: { fontSize: 12, margin: [15, 0, 0, 5] },
      correctAnswer: { fontSize: 10.5, bold: true, margin: [0, 5, 0, 5] },
      points: { fontSize: 10.5, margin: [15, 0, 0, 15] },
      error: { fontSize: 10.5, color: 'red', margin: [0, 5, 0, 5] }
    }
  };

  for (const content of contents) {
    // ---【問題ページ】---
    documentDefinition.content.push(
      { text: `問題番号: ${content.problemNumber}`, style: 'header' },
      { text: content.questionText, style: 'question' }
    );

    if (content.problemImageSrcs && content.problemImageSrcs.length > 0) {
      const tableBody = await buildImageTable(content.problemImageSrcs, 200);
      if (tableBody) {
        documentDefinition.content.push({
          table: { widths: tableBody[0].map(() => '*'), body: tableBody },
          layout: 'noBorders',
          margin: [0, 5, 0, 5]
        });
      } else {
        documentDefinition.content.push({ text: "問題画像読み込みエラー", style: 'error' });
      }
    }

    if (content.choices && content.choices.length > 0) {
      documentDefinition.content.push({ ul: content.choices, style: 'choices' });
    }
    documentDefinition.content.push({ text: '', pageBreak: 'after' });

    // ---【解説＋基本情報ページ】---
    if (content.explanation) {
      documentDefinition.content.push({ text: "解説", style: 'explanationHeader' });
      if (content.explanation.explanationImageSrcs && content.explanation.explanationImageSrcs.length > 0) {
        const tableBody = await buildImageTable(content.explanation.explanationImageSrcs, 150);
        if (tableBody) {
          documentDefinition.content.push({
            table: { widths: tableBody[0].map(() => '*'), body: tableBody },
            layout: 'noBorders',
            margin: [0, 5, 0, 5]
          });
        } else {
          documentDefinition.content.push({ text: "解説画像読み込みエラー", style: 'error' });
        }
      }
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

      // ---【基本情報】の追加：解説の後に「基本情報」ヘッダーを追加 ---
      if (content.basic) {
        documentDefinition.content.push({ text: "基本情報", style: 'explanationHeader' });
        documentDefinition.content.push({ text: content.basic.textContent, style: 'analysis' });
        if (content.basic.images && content.basic.images.length > 0) {
          if (content.basic.images.length === 1) {
            const dataUrl = await fetchImageDataUrl(content.basic.images[0]);
            if (dataUrl) {
              documentDefinition.content.push({
                image: dataUrl,
                width: 200,
                margin: [0, 5, 0, 5]
              });
            } else {
              documentDefinition.content.push({ text: "基本情報画像読み込みエラー", style: 'error' });
            }
          } else {
            const tableBody = await buildImageTable(content.basic.images, 150);
            if (tableBody) {
              documentDefinition.content.push({
                table: { widths: tableBody[0].map(() => '*'), body: tableBody },
                layout: 'noBorders',
                margin: [0, 5, 0, 5]
              });
            } else {
              documentDefinition.content.push({ text: "基本情報画像読み込みエラー", style: 'error' });
            }
          }
        }
      }
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
 * ① ログイン → ② 連続して指定件数分の問題ページをスクレイピング →  
 * ③ 各ページの【問題パート】と【解説＋基本事項パート】をPDFに配置します。
 */
async function main() {
  // 設定値（必要に応じて書き換えてください）
  const loginUrl = 'https://m3e-medical.com/users/sign_in';    // ログインページのURL
  const email = ' ';              // ログイン用メールアドレス
  const password = ' ';                              // ログイン用パスワード
  const fileName = "細胞生物学";                                    // 保存するPDFのファイル名
  const startUrl = ' ';  // 最初の問題ページURL
  const numberOfPages = 26;                                     // 連続してスクレイピングする問題数

  // ログイン処理
  const jarredFetch = await login(loginUrl, email, password);
  if (!jarredFetch) {
    console.error("ログインに失敗しました。処理を終了します。");
    return;
  }

  // 連続スクレイピング処理
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

    if (!pageContent.nextUrl) {
      console.log("次の問題URLが見つかりませんでした。終了します。");
      break;
    }
    currentUrl = pageContent.nextUrl;
  }

  // PDF生成処理
  await generatePdf(contents, fileName);
}

// 実行
main().catch((error) => console.error('エラー:', error));
