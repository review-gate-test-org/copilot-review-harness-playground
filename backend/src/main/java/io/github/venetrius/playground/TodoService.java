package io.github.venetrius.playground;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

public class TodoService {

  public static final int MAX_LENGTH = 200;

  private final List<String> todos = new ArrayList<>();

  public void add(String todo) {
    Objects.requireNonNull(todo, "todo must not be null");
    if (todo.isBlank()) {
      throw new IllegalArgumentException("todo must not be blank");
    }
    String stripped = todo.strip();
    if (stripped.length() > MAX_LENGTH) {
      throw new IllegalArgumentException("todo must not exceed " + MAX_LENGTH + " characters");
    }
    todos.add(stripped);
  }

  public List<String> list() {
    return List.copyOf(todos);
  }

  public boolean remove(String todo) {
    return todos.remove(todo);
  }
}
