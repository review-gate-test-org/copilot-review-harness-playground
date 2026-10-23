// Keep in sync with TodoService.MAX_LENGTH in the backend.
export const TODO_MAX_LENGTH = 200

export function validateTodo(todo: string): string | null {
  const stripped = todo.trim()
  if (stripped.length === 0) {
    return 'Todo must not be blank'
  }
  if (stripped.length > TODO_MAX_LENGTH) {
    return `Todo must not exceed ${TODO_MAX_LENGTH} characters`
  }
  return null
}
