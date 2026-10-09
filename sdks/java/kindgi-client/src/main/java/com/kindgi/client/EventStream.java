// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Iterator;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.jspecify.annotations.Nullable;

/**
 * A stream of server-sent events, read as they come. After a dropped connection, or a 429 or
 * 502–504 answer, it reconnects with {@code Last-Event-Id}, so no event is lost (backing off from
 * 0.5 s to 30 s, up to 10 in a row); any other error answer throws. It ends when the server closes
 * it ({@code runs().follow} goes on to the run's end). Close it to stop early:
 *
 * <pre>{@code
 * try (EventStream<RunEvent> events = client.runs().stream(run.id())) {
 *   for (RunEvent event : events) {
 *     System.out.println(event);
 *   }
 * }
 * }</pre>
 *
 * <p>An event's {@code data} that isn't JSON is skipped, as the other Kindgi clients do; one that
 * is JSON but doesn't match the event's type ends the stream with a {@link KindgiApiException}.
 *
 * @param <T> the event type
 */
public interface EventStream<T> extends Iterator<T>, Iterable<T>, AutoCloseable {
  /** @return the id of the last event read, sent as {@code Last-Event-Id} on a reconnect */
  @Nullable String lastEventId();

  /** Stops reading and releases the connection. */
  @Override
  void close();

  /** @return this stream, for a for-each loop (it can be iterated once) */
  @Override
  default Iterator<T> iterator() {
    return this;
  }

  /** @return the events as a {@link Stream}; closing it closes this */
  default Stream<T> stream() {
    return StreamSupport.stream(Spliterators.spliteratorUnknownSize(this, Spliterator.ORDERED | Spliterator.NONNULL), false)
        .onClose(this::close);
  }
}
