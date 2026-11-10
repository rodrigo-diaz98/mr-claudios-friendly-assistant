import type { Register } from 'claude-code'

const BRIDGE_URL = 'http://127.0.0.1:4317/api/bridge'
const POLL_MS = 1000

type Answers = Record<string, string>
type Answer = { text?: string; answers?: Answers }
type Question = { question: string }

export const register: Register = on => {
  let answerOpenQuestions: ((answers: Answers) => void) | null = null
  let openQuestions: readonly Question[] = []

  const answersFor = (answer: Answer): Answers =>
    answer.answers ?? Object.fromEntries(openQuestions.map(({ question }) => [question, answer.text ?? '']))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const sessionId = await $.session.id()
    $.clock.every(POLL_MS, () => {
      void $.http
        .fetch(`${BRIDGE_URL}/${sessionId}/answer`)
        .then(response => {
          if (response.status !== 200) {
            return
          }
          const answer: Answer = JSON.parse(response.text)
          if (answerOpenQuestions) {
            answerOpenQuestions(answersFor(answer))
          } else if (answer.text) {
            void $.prompt.submit({ text: answer.text, asUser: true })
          }
        })
        .catch(() => undefined)
    })
    return started
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const sessionId = await $.session.id()
    const publishQuestions = (questions: readonly Question[] | null) =>
      $.http
        .fetch(`${BRIDGE_URL}/${sessionId}/questions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ questions }),
        })
        .catch(() => undefined)

    openQuestions = e.questions
    await publishQuestions(e.questions)
    const answeredFromAssistant = new Promise<Answers>(resolve => {
      answerOpenQuestions = resolve
    })
    try {
      const winner = await Promise.race([
        next(e).then(ran => ({ ran })),
        answeredFromAssistant.then(answers => ({ answers })),
      ])
      return 'ran' in winner ? winner.ran : { result: { questions: e.questions, answers: winner.answers } }
    } finally {
      answerOpenQuestions = null
      openQuestions = []
      await publishQuestions(null)
    }
  })
}
