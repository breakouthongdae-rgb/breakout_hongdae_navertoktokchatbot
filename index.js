const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const FAQ_FILE = path.join(__dirname, 'talk.txt');
const FALLBACK_ANSWER = '죄송해요. 등록된 답변에서 내용을 찾지 못했어요. 상담원에게 문의해 주세요.';

function normalizeText(text) {
    return text.toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
}

function loadFaq() {
    const contents = fs.readFileSync(FAQ_FILE, 'utf8');
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