import { parseChatInput } from '../src/chat/commandParser'
import type { OnlineUser } from '../src/chat/types'

const users: OnlineUser[] = [
  { id: 'self-111111', name: 'Self' },
  { id: 'alice-aaaaaa', name: 'Alice' },
  { id: 'bob-bbbbbb', name: 'Bob' },
]

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

// Basic parser smoke checks for command and literal text behavior.
const plain = parseChatInput(' /teleport should be plain', users, 'self-111111')
assert(plain.kind === 'plain', 'Expected leading-space slash to be plain text')

const tag = parseChatInput('@tag @Alice hello', users, 'self-111111')
assert(tag.kind === 'tag', 'Expected @tag parsing to succeed')

const tagWithoutPayload = parseChatInput('@tag', users, 'self-111111')
assert(tagWithoutPayload.kind === 'error', 'Expected bare @tag to fail')

const tagWithoutMessage = parseChatInput('@tag @Alice', users, 'self-111111')
assert(tagWithoutMessage.kind === 'error', 'Expected @tag without message to fail')

const tp = parseChatInput('/teleport @Bob move please', users, 'self-111111')
assert(tp.kind === 'teleport', 'Expected /teleport parsing to succeed')
