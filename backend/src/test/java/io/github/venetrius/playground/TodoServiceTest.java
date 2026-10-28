package io.github.venetrius.playground;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class TodoServiceTest {

  private final TodoService service = new TodoService();

  @Test
  void addsAndListsTodos() {
    service.add("  write tests ");
    assertEquals(List.of("write tests"), service.list());
  }

  @Test
  void rejectsBlankTodo() {
    assertThrows(IllegalArgumentException.class, () -> service.add("   "));
  }

  @Test
  void removesTodo() {
    service.add("ship it");
    assertTrue(service.remove("ship it"));
    assertTrue(service.list().isEmpty());
  }

  @Test
  void countsTodos() {
    service.add("a");
    service.add("b");
    assertEquals(2, service.size());
  }
}
