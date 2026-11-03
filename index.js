const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const FAQ_FILE = path.join(__dirname, 'talk.txt');
const ADMIN_FILE = path.join(__dirname, 'admin.html');
const FALLBACK_ANSWER = '죄송해요. 등록된 답변에서 내용을 찾지 못했어요. 상담원에게 문의해 주세요.';

function normalizeText(text) {
    return text.toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
}

function parseFaq(contents) {
    const entries = [];
    const questions = new Set();

    contents.split(/\r?\n/).forEach((line, index) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) {
            return;
        }

        const separatorIndex = trimmedLine.indexOf(':');
        if (separatorIndex < 1) {
            throw new Error(`talk.txt ${index + 1}행에 질문과 답변 사이의 ':'가 없습니다.`);
        }

        const question = trimmedLine.slice(0, separatorIndex).trim();
        const answer = trimmedLine.slice(separatorIndex + 1).trim();
        if (!question || !answer) {
            throw new Error(`talk.txt ${index + 1}행의 질문 또는 답변이 비어 있습니다.`);
        }

        const normalizedQuestion = normalizeText(question);
        if (questions.has(normalizedQuestion)) {
            throw new Error(`talk.txt ${index + 1}행의 질문이 중복되었습니다: ${question}`);
        }

        questions.add(normalizedQuestion);
        entries.push({ question: normalizedQuestion, answer });
    });

    if (entries.length === 0) {
        throw new Error('talk.txt에 질문과 답변을 한 개 이상 적어 주세요.');
    }

    return entries;
}

function loadFaq() {
    return parseFaq(fs.readFileSync(FAQ_FILE, 'utf8'));
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

async function githubRequest(config, method, body) {
    const ref = method === 'GET' ? `?ref=${encodeURIComponent(config.branch)}` : '';
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents/talk.txt${ref}`;
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
        const file = await githubRequest(config, 'GET');
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

    try {
        parseFaq(req.body.content);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    try {
        const config = getAdminConfig();
        const file = await githubRequest(config, 'GET');
        const updatedFile = await githubRequest(config, 'PUT', {
            message: 'Update FAQ via admin editor',
            content: Buffer.from(req.body.content, 'utf8').toString('base64'),
            sha: file.sha,
            branch: config.branch
        });
        return res.json({
            message: '저장했습니다. GitHub 커밋 후 Render가 자동 배포합니다.',
            commit: updatedFile.commit && updatedFile.commit.html_url
        });
    } catch (error) {
        console.error('FAQ 파일을 저장하지 못했습니다:', error.message);
        const status = error.status === 409 ? 409 : 502;
        return res.status(status).json({
            error: status === 409
                ? '파일이 다른 곳에서 변경되었습니다. 새로고침한 뒤 다시 저장해 주세요.'
                : 'GitHub에 저장하지 못했습니다. 저장소와 토큰 권한을 확인해 주세요.'
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
    const exactMatch = entries.find((entry) => entry.question === normalizedMessage);
    if (exactMatch) {
        return exactMatch.answer;
    }

    const partialMatch = [...entries]
        .sort((first, second) => second.question.length - first.question.length)
        .find((entry) => normalizedMessage.includes(entry.question));

    return partialMatch ? partialMatch.answer : FALLBACK_ANSWER;
}

app.post('/webhook', (req, res) => {
    if (req.body.event !== 'send') {
        return res.sendStatus(200);
    }

    const message = extractMessage(req.body);
    if (!message) {
        return res.sendStatus(200);
    }

    try {
        const answer = findAnswer(message, loadFaq());
        return res.status(200).json({
            event: 'send',
            textContent: { text: answer }
        });
    } catch (error) {
        console.error('답변을 처리하지 못했습니다:', error.message);
        return res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`챗봇 서버가 ${PORT}번 포트에서 실행 중입니다.`);
});