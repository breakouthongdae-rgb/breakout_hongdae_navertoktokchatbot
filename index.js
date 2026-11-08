const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const FAQ_FILE = path.join(__dirname, 'talk.txt');
const FAQ_EXAMPLES_FILE = path.join(__dirname, 'faq_examples.txt');
const ADMIN_FILE = path.join(__dirname, 'admin.html');
const MONITOR_FILE = path.join(__dirname, 'monitor.html');
const MONITOR_EVENTS_FILE = path.join(__dirname, 'monitor-events.html');
const FALLBACK_ANSWER = '죄송해요. 등록된 답변에서 내용을 찾지 못했어요. 상담원에게 문의해 주세요.';
const MAX_RECENT_WEBHOOK_ISSUES = 100;
const startedAt = Date.now();
const webhookResults = {
    answered: 0,
    fallback: 0,
    ignored: 0,
    error: 0
};
let webhookRequestCount = 0;
let lastWebhookTimestamp = 0;
let lastFaqError = '';
const recentWebhookIssues = [];

function recordWebhookIssue(result, question, reason) {
    recentWebhookIssues.unshift({
        timestamp: new Date().toISOString(),
        result,
        question: question.slice(0, 500),
        reason
    });
    if (recentWebhookIssues.length > MAX_RECENT_WEBHOOK_ISSUES) {
        recentWebhookIssues.length = MAX_RECENT_WEBHOOK_ISSUES;
    }
}

function normalizeText(text) {
    return text.toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
}

function compactText(text) {
    return normalizeText(text).replace(/[^\p{L}\p{N}]/gu, '');
}

function getEditDistance(first, second) {
    const firstCharacters = Array.from(first);
    const secondCharacters = Array.from(second);
    let previousRow = Array.from({ length: secondCharacters.length + 1 }, (_, index) => index);

    for (let firstIndex = 1; firstIndex <= firstCharacters.length; firstIndex += 1) {
        const currentRow = [firstIndex];
        for (let secondIndex = 1; secondIndex <= secondCharacters.length; secondIndex += 1) {
            const substitutionCost = firstCharacters[firstIndex - 1] === secondCharacters[secondIndex - 1] ? 0 : 1;
            currentRow[secondIndex] = Math.min(
                previousRow[secondIndex] + 1,
                currentRow[secondIndex - 1] + 1,
                previousRow[secondIndex - 1] + substitutionCost
            );
        }
        previousRow = currentRow;
    }

    return previousRow[secondCharacters.length];
}

function findFuzzyExampleAnswer(message, entries) {
    const compactMessage = compactText(message);
    if (compactMessage.length < 8 || compactMessage.length > 120) {
        return null;
    }

    const messageNumbers = (compactMessage.match(/\d+/g) || []).join(',');
    const matches = [];
    for (const entry of entries) {
        for (const example of entry.examples || []) {
            const compactExample = compactText(example);
            if (compactExample.length < 8 ||
                (compactExample.match(/\d+/g) || []).join(',') !== messageNumbers) {
                continue;
            }

            const maxDistance = Math.min(2, Math.max(1, Math.floor(compactExample.length * 0.12)));
            if (Math.abs(compactMessage.length - compactExample.length) > maxDistance) {
                continue;
            }

            const distance = getEditDistance(compactMessage, compactExample);
            if (distance <= maxDistance) {
                matches.push({ entry, distance });
            }
        }
    }

    if (matches.length === 0) {
        return null;
    }

    const bestDistance = Math.min(...matches.map((match) => match.distance));
    const bestEntries = new Set(matches
        .filter((match) => match.distance === bestDistance)
        .map((match) => match.entry));
    return bestEntries.size === 1
        ? [...bestEntries][0].answer
        : null;
}

const CORE_QUESTION_STOPWORDS = new Set([
    '것', '거', '수', '때', '정도', '정도는', '같', '조금', '혹시', '그냥',
    '어떻게', '어떤', '무엇', '뭐', '하나', '방법', '문의', '질문', '답변',
    '알려', '부탁', '가능', '가능성', '있', '없', '하', '되', '해',
    '인가', '인가요', '나요', '네요', '까요', '인가요',
    '은', '는', '이', '가', '을', '를', '에', '로', '와', '과', '도', '만', '의',
    '하고', '해서', '하며', '그리고', '또는', '저희', '제가', '저는'
]);
const CORE_QUESTION_ENDINGS = [
    '을것같습니다', '을것같아요', '을것같은데요', '을것', '는다는', 'ㄴ다는',
    '습니다', '습니까', '입니다', '할까요', '인가요', '은데요', '는데요',
    'ㄴ데요', '을까요', '을게요', 'ㄹ게요', '했어요', '해요', '돼요',
    '어요', '아요', '예요', '에요', '네요', '군요', '세요', '합니다',
    '하는', '하면', '해서', '하고', '하며', '되어', '되면', '되나요',
    '인가', '이나', '라도', '부터', '까지', '에게', '한테', '으로',
    '에서', '보다', '처럼', '정도', '으로', '은요', '는요', '을', '를',
    '은', '는', '이', '가', '에', '로', '와', '과', '도', '만', '의',
    '전', '후', '쯤', '요', '다'
].sort((first, second) => second.length - first.length);

function getCoreQuestionKeywords(text) {
    const tokens = text.toLocaleLowerCase('ko-KR').match(/\d[\d,]*|[\p{L}]+/gu) || [];
    return new Set(tokens.map((token) => {
        if (/^\d[\d,]*$/.test(token)) {
            return token.replace(/,/g, '');
        }

        let keyword = token;
        let changed = true;
        while (changed) {
            changed = false;
            for (const ending of CORE_QUESTION_ENDINGS) {
                if (keyword.length - ending.length >= 1 && keyword.endsWith(ending)) {
                    keyword = keyword.slice(0, -ending.length);
                    changed = true;
                    break;
                }
            }
        }
        return keyword;
    }).filter((keyword) =>
        keyword.length >= 1 && !CORE_QUESTION_STOPWORDS.has(keyword)));
}

function getQuestionNumbers(text) {
    return (text.match(/\d[\d,]*/g) || []).map((number) => number.replace(/,/g, ''));
}

function findCoreKeywordAnswer(message, entries) {
    const messageKeywords = getCoreQuestionKeywords(message);
    if (messageKeywords.size < 2) {
        return null;
    }

    const messageNumbers = getQuestionNumbers(message);
    const candidates = entries.map((entry) => {
        let bestScore = 0;
        let bestOverlap = 0;

        for (const phrase of [entry.title, ...(entry.examples || [])]) {
            const phraseNumbers = getQuestionNumbers(phrase);
            if (messageNumbers.length > 0 && phraseNumbers.length > 0 &&
                messageNumbers.join(',') !== phraseNumbers.join(',')) {
                continue;
            }

            const phraseKeywords = getCoreQuestionKeywords(phrase);
            let overlap = 0;
            for (const keyword of messageKeywords) {
                if (phraseKeywords.has(keyword)) {
                    overlap += 1;
                }
            }

            const score = phraseKeywords.size === 0
                ? 0
                : (2 * overlap) / (messageKeywords.size + phraseKeywords.size);
            if (score > bestScore) {
                bestScore = score;
                bestOverlap = overlap;
            }
        }

        return { entry, score: bestScore, overlap: bestOverlap };
    }).sort((first, second) => second.score - first.score);

    const bestMatch = candidates[0];
    const nextMatch = candidates[1];
    return bestMatch && bestMatch.overlap >= 2 && bestMatch.score >= 0.62 &&
        (!nextMatch || bestMatch.score - nextMatch.score >= 0.12)
        ? bestMatch.entry.answer
        : null;
}

function parseFaq(contents) {
    const entries = [];
    const questions = new Set();
    let currentEntry = null;

    function saveCurrentEntry() {
        if (!currentEntry) {
            return;
        }

        const answer = currentEntry.answer.join('\n')
            .replace(/\\(\\|n)/g, (match, escaped) => escaped === 'n' ? '\n' : '\\')
            .trim();
        if (!answer) {
            throw new Error(`talk.txt ${currentEntry.lineNumber}행의 답변이 비어 있습니다.`);
        }

        const normalizedQuestion = normalizeText(currentEntry.question);
        if (questions.has(normalizedQuestion)) {
            throw new Error(`talk.txt ${currentEntry.lineNumber}행의 질문이 중복되었습니다: ${currentEntry.question}`);
        }

        questions.add(normalizedQuestion);
        entries.push({ question: normalizedQuestion, title: currentEntry.question.trim(), answer });
        currentEntry = null;
    }

    contents.split(/\r?\n/).forEach((line, index) => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#')) {
            return;
        }

        const separatorIndex = line.indexOf(':');
        if (separatorIndex > 0 && line.slice(0, separatorIndex).trim()) {
            saveCurrentEntry();
            currentEntry = {
                question: line.slice(0, separatorIndex).trim(),
                answer: [line.slice(separatorIndex + 1).trim()],
                lineNumber: index + 1
            };
            return;
        }

        if (currentEntry) {
            currentEntry.answer.push(line);
        } else if (trimmedLine) {
            throw new Error(`talk.txt ${index + 1}행에 질문과 답변 사이의 ':'가 없습니다.`);
        }
    });
    saveCurrentEntry();

    if (entries.length === 0) {
        throw new Error('talk.txt에 질문과 답변을 한 개 이상 적어 주세요.');
    }

    return entries;
}

function loadFaq() {
    const entries = parseFaq(fs.readFileSync(FAQ_FILE, 'utf8'));
    const entriesByQuestion = new Map(entries.map((entry) => [entry.question, entry]));
    const examplesByText = new Map();
    const examples = fs.readFileSync(FAQ_EXAMPLES_FILE, 'utf8');

    examples.split(/\r?\n/).forEach((line, index) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            return;
        }

        const separatorIndex = line.indexOf(':');
        if (separatorIndex <= 0) {
            throw new Error(`faq_examples.txt ${index + 1}행에 대표 질문과 예시 문장 사이의 ':'가 없습니다.`);
        }

        const question = normalizeText(line.slice(0, separatorIndex));
        const entry = entriesByQuestion.get(question);
        if (!entry) {
            console.warn(`faq_examples.txt ${index + 1}행의 대표 질문을 talk.txt에서 찾을 수 없습니다: ${question}`);
            return;
        }

        entry.examples = entry.examples || [];
        for (const example of line.slice(separatorIndex + 1).split('|').map(normalizeText).filter(Boolean)) {
            const compactExample = compactText(example);
            const existing = examplesByText.get(compactExample);
            if (existing && existing !== entry) {
                throw new Error(`faq_examples.txt ${index + 1}행의 예시 문장이 다른 질문과 중복됩니다: ${example}`);
            }

            examplesByText.set(compactExample, entry);
            entry.examples.push(example);
        }
    });

    return entries;
}

function getFaqStatus() {
    try {
        const entries = loadFaq().length;
        lastFaqError = '';
        return { ready: true, entries };
    } catch (error) {
        if (error.message !== lastFaqError) {
            console.error('FAQ 상태 확인 실패:', error.message);
            lastFaqError = error.message;
        }
        return { ready: false, entries: 0 };
    }
}

app.get(['/health', '/healthz'], (req, res) => {
    const faqStatus = getFaqStatus();
    return res.status(faqStatus.ready ? 200 : 503).json({
        status: faqStatus.ready ? 'ok' : 'degraded',
        faq: faqStatus.ready ? 'ready' : 'unavailable',
        faqEntries: faqStatus.entries,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
    });
});

app.get('/monitor/api', (req, res) => {
    const faqStatus = getFaqStatus();
    res.set('Cache-Control', 'no-store');
    return res.json({
        status: faqStatus.ready ? 'ok' : 'degraded',
        faqReady: faqStatus.ready,
        faqEntries: faqStatus.entries,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        webhookRequests: webhookRequestCount,
        webhookResponses: { ...webhookResults },
        lastWebhookTimestamp
    });
});

app.get('/monitor/events', requireMonitorAdmin, (req, res) => {
    return res.sendFile(MONITOR_EVENTS_FILE);
});

app.get('/monitor/events/api', requireMonitorAdmin, (req, res) => {
    const result = req.query.result;
    if (!['fallback', 'ignored', 'error'].includes(result)) {
        return res.status(400).json({ error: '올바른 기록 종류를 지정해 주세요.' });
    }

    res.set('Cache-Control', 'no-store');
    return res.json({
        result,
        events: recentWebhookIssues.filter((event) => event.result === result)
    });
});

app.get('/monitor', (req, res) => {
    return res.sendFile(MONITOR_FILE);
});

app.get('/metrics', (req, res) => {
    const faqStatus = getFaqStatus();
    const metrics = [
        '# HELP chatbot_up Whether the chatbot process is running.',
        '# TYPE chatbot_up gauge',
        'chatbot_up 1',
        '# HELP chatbot_faq_ready Whether FAQ files can be loaded and parsed.',
        '# TYPE chatbot_faq_ready gauge',
        `chatbot_faq_ready ${faqStatus.ready ? 1 : 0}`,
        '# HELP chatbot_faq_entries Number of loaded FAQ entries.',
        '# TYPE chatbot_faq_entries gauge',
        `chatbot_faq_entries ${faqStatus.entries}`,
        '# HELP chatbot_webhook_requests_total Number of webhook requests received.',
        '# TYPE chatbot_webhook_requests_total counter',
        `chatbot_webhook_requests_total ${webhookRequestCount}`,
        '# HELP chatbot_webhook_responses_total Webhook responses by result.',
        '# TYPE chatbot_webhook_responses_total counter',
        ...Object.entries(webhookResults).map(([result, count]) =>
            `chatbot_webhook_responses_total{result="${result}"} ${count}`),
        '# HELP chatbot_last_webhook_timestamp_seconds Unix timestamp of the last webhook request.',
        '# TYPE chatbot_last_webhook_timestamp_seconds gauge',
        `chatbot_last_webhook_timestamp_seconds ${lastWebhookTimestamp}`,
        '# HELP process_uptime_seconds Process uptime in seconds.',
        '# TYPE process_uptime_seconds gauge',
        `process_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(3)}`
    ];

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(`${metrics.join('\n')}\n`);
});

function updateFaqExamples(contents, entries) {
    const examplesByQuestion = new Map();
    const headerLines = [];
    let foundEntry = false;

    contents.split(/\r?\n/).forEach((line, index) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            if (!foundEntry) {
                headerLines.push(line);
            }
            return;
        }

        const separatorIndex = line.indexOf(':');
        if (separatorIndex <= 0) {
            throw new Error(`faq_examples.txt ${index + 1}행에 대표 질문과 예시 문장 사이의 ':'가 없습니다.`);
        }

        const question = normalizeText(line.slice(0, separatorIndex));
        if (examplesByQuestion.has(question)) {
            throw new Error(`faq_examples.txt ${index + 1}행의 대표 질문이 중복되었습니다: ${question}`);
        }

        foundEntry = true;
        examplesByQuestion.set(question, line.slice(separatorIndex + 1).trim());
    });

    const updatedEntries = entries.map((entry) =>
        `${entry.title} : ${examplesByQuestion.get(entry.question) || ''}`);
    const header = headerLines.join('\n').trimEnd();
    return `${header ? `${header}\n\n` : ''}${updatedEntries.join('\n')}\n`;
}

function getAdminConfig() {
    const repository = process.env.GITHUB_REPOSITORY || '';
    const [owner, name, ...extra] = repository.split('/');

    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD || !process.env.GITHUB_TOKEN ||
        !owner || !name || extra.length > 0) {
        return null;
    }

    return {
        user: process.env.ADMIN_USER,
        password: process.env.ADMIN_PASSWORD,
        token: process.env.GITHUB_TOKEN,
        owner,
        repository: name,
        branch: process.env.GITHUB_BRANCH || 'main'
    };
}

function safeEqual(first, second) {
    const firstBuffer = Buffer.from(first);
    const secondBuffer = Buffer.from(second);
    return firstBuffer.length === secondBuffer.length &&
        require('crypto').timingSafeEqual(firstBuffer, secondBuffer);
}

function requireAdmin(req, res, next) {
    const config = getAdminConfig();
    if (!config) {
        return res.status(503).send('관리자 기능 설정이 완료되지 않았습니다.');
    }

    const authorization = req.get('authorization') || '';
    const encodedCredentials = authorization.match(/^Basic\s+(.+)$/i);
    if (encodedCredentials) {
        try {
            const decoded = Buffer.from(encodedCredentials[1], 'base64').toString('utf8');
            const separatorIndex = decoded.indexOf(':');
            if (separatorIndex !== -1 &&
                safeEqual(decoded.slice(0, separatorIndex), config.user) &&
                safeEqual(decoded.slice(separatorIndex + 1), config.password)) {
                res.set('Cache-Control', 'no-store');
                return next();
            }
        } catch (error) {
            console.error('관리자 인증 정보를 확인하지 못했습니다:', error.message);
        }
    }

    res.set('WWW-Authenticate', 'Basic realm="FAQ Admin", charset="UTF-8"');
    return res.sendStatus(401);
}

function requireMonitorAdmin(req, res, next) {
    const user = process.env.ADMIN_USER;
    const password = process.env.ADMIN_PASSWORD;
    if (!user || !password) {
        return res.status(503).send('질문 기록을 보려면 Render에 ADMIN_USER와 ADMIN_PASSWORD를 설정해 주세요.');
    }

    const authorization = req.get('authorization') || '';
    const encodedCredentials = authorization.match(/^Basic\s+(.+)$/i);
    if (encodedCredentials) {
        try {
            const decoded = Buffer.from(encodedCredentials[1], 'base64').toString('utf8');
            const separatorIndex = decoded.indexOf(':');
            if (separatorIndex !== -1 &&
                safeEqual(decoded.slice(0, separatorIndex), user) &&
                safeEqual(decoded.slice(separatorIndex + 1), password)) {
                res.set('Cache-Control', 'no-store');
                return next();
            }
        } catch (error) {
            console.error('질문 기록 접근 인증에 실패했습니다:', error.message);
        }
    }

    res.set('WWW-Authenticate', 'Basic realm="Webhook Question History", charset="UTF-8"');
    return res.sendStatus(401);
}

function requireSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin) {
        return res.status(403).json({ error: '같은 웹사이트에서 저장 요청을 보내 주세요.' });
    }

    try {
        if (new URL(origin).host !== req.get('host')) {
            return res.status(403).json({ error: '다른 웹사이트에서의 저장 요청은 허용되지 않습니다.' });
        }
    } catch (error) {
        return res.status(403).json({ error: '올바르지 않은 요청 출처입니다.' });
    }

    return next();
}

async function githubRequest(config, method, fileName, body) {
    const ref = method === 'GET' ? `?ref=${encodeURIComponent(config.branch)}` : '';
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents/${encodeURIComponent(fileName)}${ref}`;
    const response = await fetch(apiUrl, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${config.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'navertoktok-faq-editor',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000)
    });
    const responseText = await response.text();
    let result = {};
    if (responseText) {
        try {
            result = JSON.parse(responseText);
        } catch (error) {
            throw new Error(`GitHub API가 올바르지 않은 응답을 반환했습니다 (HTTP ${response.status}).`);
        }
    }

    if (!response.ok) {
        const error = new Error(result.message || `GitHub API 요청 실패 (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
    }

    return result;
}

app.get('/admin', requireAdmin, (req, res) => {
    return res.sendFile(ADMIN_FILE);
});

app.get('/admin/api/talk', requireAdmin, async (req, res) => {
    try {
        const config = getAdminConfig();
        const file = await githubRequest(config, 'GET', 'talk.txt');
        if (!file.content || !file.sha) {
            throw new Error('GitHub에서 talk.txt 파일 내용을 확인할 수 없습니다.');
        }
        return res.json({ content: Buffer.from(file.content, 'base64').toString('utf8') });
    } catch (error) {
        console.error('FAQ 파일을 불러오지 못했습니다:', error.message);
        return res.status(502).json({ error: 'GitHub에서 talk.txt를 불러오지 못했습니다. 저장소와 토큰 설정을 확인해 주세요.' });
    }
});

app.put('/admin/api/talk', requireAdmin, requireSameOrigin, async (req, res) => {
    if (typeof req.body.content !== 'string') {
        return res.status(400).json({ error: '저장할 텍스트 내용을 입력해 주세요.' });
    }
    if (Buffer.byteLength(req.body.content, 'utf8') > 64000) {
        return res.status(413).json({ error: '텍스트가 너무 깁니다. 64KB 이하로 줄여 주세요.' });
    }

    let faqEntries;
    try {
        faqEntries = parseFaq(req.body.content);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    let talkSaved = false;
    try {
        const config = getAdminConfig();
        const [talkFile, examplesFile] = await Promise.all([
            githubRequest(config, 'GET', 'talk.txt'),
            githubRequest(config, 'GET', 'faq_examples.txt')
        ]);
        if (!talkFile.content || !talkFile.sha || !examplesFile.content || !examplesFile.sha) {
            throw new Error('GitHub에서 FAQ 파일 내용을 확인할 수 없습니다.');
        }

        const examplesContent = updateFaqExamples(
            Buffer.from(examplesFile.content, 'base64').toString('utf8'),
            faqEntries
        );
        if (Buffer.byteLength(examplesContent, 'utf8') > 64000) {
            return res.status(413).json({ error: '질문 예시 파일이 너무 깁니다. 64KB 이하로 줄여 주세요.' });
        }

        const updatedFile = await githubRequest(config, 'PUT', 'talk.txt', {
            message: 'Update FAQ via admin editor',
            content: Buffer.from(req.body.content, 'utf8').toString('base64'),
            sha: talkFile.sha,
            branch: config.branch
        });
        talkSaved = true;

        await githubRequest(config, 'PUT', 'faq_examples.txt', {
            message: 'Sync FAQ examples with questions',
            content: Buffer.from(examplesContent, 'utf8').toString('base64'),
            sha: examplesFile.sha,
            branch: config.branch
        });

        return res.json({
            message: '질문·답변과 질문 예시를 GitHub에 저장했습니다. Render가 자동 배포합니다.',
            commit: updatedFile.commit && updatedFile.commit.html_url
        });
    } catch (error) {
        console.error('FAQ 파일을 저장하지 못했습니다:', error.message);
        const status = error.status === 409 ? 409 : 502;
        return res.status(status).json({
            error: status === 409
                ? (talkSaved
                    ? '질문·답변은 저장됐지만 질문 예시 파일이 다른 곳에서 변경되었습니다. 새로고침한 뒤 다시 저장해 주세요.'
                    : '파일이 다른 곳에서 변경되었습니다. 새로고침한 뒤 다시 저장해 주세요.')
                : (talkSaved
                    ? '질문·답변은 저장됐지만 질문 예시 파일을 저장하지 못했습니다. 다시 저장해 동기화를 완료해 주세요.'
                    : 'GitHub에 저장하지 못했습니다. 저장소와 토큰 권한을 확인해 주세요.')
        });
    }
});

function extractMessage(payload, depth = 0) {
    if (depth > 5 || !payload || typeof payload !== 'object') {
        return '';
    }

    for (const key of ['text', 'content', 'message', 'query']) {
        if (typeof payload[key] === 'string' && payload[key].trim()) {
            return payload[key].trim();
        }
    }

    for (const key of ['textContent', 'message', 'event', 'data', 'userMessage']) {
        const message = extractMessage(payload[key], depth + 1);
        if (message) {
            return message;
        }
    }

    return '';
}

function findAnswer(message, entries) {
    const normalizedMessage = normalizeText(message);
    const compactMessage = compactText(message);
    const exactMatch = entries.find((entry) => entry.question === normalizedMessage);
    if (exactMatch) {
        return exactMatch.answer;
    }

    const exactExampleMatches = entries.filter((entry) =>
        (entry.examples || []).some((example) => compactText(example) === compactMessage));
    if (exactExampleMatches.length === 1) {
        return exactExampleMatches[0].answer;
    }

    const coreKeywordAnswer = findCoreKeywordAnswer(message, entries);
    if (coreKeywordAnswer) {
        return coreKeywordAnswer;
    }

    const partialMatches = entries.map((entry) => {
        const phrase = [entry.question, ...(entry.examples || [])]
            .filter((candidate) => {
                const compactCandidate = compactText(candidate);
                return compactCandidate.length >= 4 &&
                    (compactMessage.includes(compactCandidate) ||
                        (compactMessage.length >= 4 && compactCandidate.includes(compactMessage)));
            })
            .sort((first, second) => compactText(second).length - compactText(first).length)[0];
        return phrase ? { entry, phrase } : null;
    }).filter(Boolean)
        .sort((first, second) => compactText(second.phrase).length - compactText(first.phrase).length);
    if (partialMatches.length > 0 &&
        (partialMatches.length === 1 ||
            compactText(partialMatches[0].phrase).length > compactText(partialMatches[1].phrase).length)) {
        return partialMatches[0].entry.answer;
    }

    const fuzzyExampleAnswer = findFuzzyExampleAnswer(message, entries);
    if (fuzzyExampleAnswer) {
        return fuzzyExampleAnswer;
    }

    const ignoredWords = new Set([
        '어떻게', '어떤', '무엇', '뭐', '하나요', '하나', '할까요', '인가요',
        '인가', '방법', '알려주세요', '궁금해요', '해주세요', '해줘', '부탁해요',
        '가능한가요', '가능해요', '있나요', '없나요', '되나요'
    ]);
    const endings = [
        '하려면', '하려고', '에서는', '에게', '한테', '으로', '부터', '까지',
        '하는', '하기', '에서', '은요', '인가요', '할까요', '해주세요',
        '은', '는', '이', '가', '을', '를', '에', '로', '와', '과', '도',
        '만', '의', '방법'
    ];

    function getKeywords(text) {
        const words = text.toLocaleLowerCase('ko-KR').match(/[\p{L}\p{N}]+/gu) || [];
        return new Set(words.map((word) => {
            let keyword = word;
            let changed = true;
            while (changed) {
                changed = false;
                for (const ending of endings) {
                    if (keyword.length - ending.length >= 2 && keyword.endsWith(ending)) {
                        keyword = keyword.slice(0, -ending.length);
                        changed = true;
                        break;
                    }
                }
            }
            return keyword;
        }).filter((word) => word.length >= 2 && !ignoredWords.has(word)));
    }

    const messageKeywords = getKeywords(message);
    if (messageKeywords.size === 0) {
        return FALLBACK_ANSWER;
    }

    const candidates = entries.map((entry) => {
        const questionPhrases = [entry.question, ...(entry.examples || [])];
        const answerKeywords = getKeywords(entry.answer);
        let answerOverlap = 0;
        for (const keyword of messageKeywords) {
            if (answerKeywords.has(keyword)) {
                answerOverlap += 1;
            }
        }

        const questionScore = Math.max(...questionPhrases.map((phrase) => {
            const questionKeywords = getKeywords(phrase);
            let overlap = 0;
            for (const keyword of messageKeywords) {
                if (questionKeywords.has(keyword)) {
                    overlap += 1;
                }
            }
            return questionKeywords.size === 0
                ? 0
                : (2 * overlap) / (messageKeywords.size + questionKeywords.size);
        }));
        const answerCoverage = answerOverlap / messageKeywords.size;
        const compactAnswer = compactText(entry.answer);
        const answerPhraseMatch = compactMessage.length >= 3 && compactAnswer.includes(compactMessage);
        const answerScore = Math.max(answerCoverage * 0.85, answerPhraseMatch ? 0.9 : 0);
        const score = Math.max(questionScore, answerScore);
        return { entry, score };
    }).sort((first, second) => second.score - first.score);

    const bestMatch = candidates[0];
    const hasTie = candidates[1] && candidates[1].score === bestMatch.score;
    return bestMatch.score >= 0.8 && !hasTie
        ? bestMatch.entry.answer
        : FALLBACK_ANSWER;
}

app.post('/webhook', (req, res) => {
    webhookRequestCount += 1;
    lastWebhookTimestamp = Math.floor(Date.now() / 1000);
    const message = extractMessage(req.body);

    if (req.body.event !== 'send') {
        webhookResults.ignored += 1;
        recordWebhookIssue('ignored', message, 'send 이벤트가 아닙니다.');
        return res.sendStatus(200);
    }

    if (!message) {
        webhookResults.ignored += 1;
        recordWebhookIssue('ignored', '', '질문 문장을 추출할 수 없습니다.');
        return res.sendStatus(200);
    }

    try {
        const answer = findAnswer(message, loadFaq());
        if (answer === FALLBACK_ANSWER) {
            webhookResults.fallback += 1;
            recordWebhookIssue('fallback', message, '일치하는 FAQ 답변을 찾지 못했습니다.');
        } else {
            webhookResults.answered += 1;
        }
        return res.status(200).json({
            event: 'send',
            textContent: { text: answer }
        });
    } catch (error) {
        webhookResults.error += 1;
        recordWebhookIssue('error', message, error.message);
        console.error('답변을 처리하지 못했습니다:', error.message);
        return res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`챗봇 서버가 ${PORT}번 포트에서 실행 중입니다.`);
});