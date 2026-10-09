// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.function.Function;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.jspecify.annotations.Nullable;

/** Every item of a cursor-paginated list, as a lazy stream: what the generated {@code …All} methods return. */
public final class Paging {
  private Paging() {}

  /**
   * @param <P> the page type
   * @param <T> the item type
   * @param fetch fetches a page: {@code null} for the first, else the cursor to continue from
   * @param data a page's items
   * @param hasMore whether there's another page ({@code null} from an older server: whether there's a cursor)
   * @param nextCursor where the next page starts
   * @return the items, fetched page by page as the stream reaches them
   */
  public static <P, T> Stream<T> stream(
      Function<@Nullable String, P> fetch,
      Function<P, List<T>> data,
      Function<P, @Nullable Boolean> hasMore,
      Function<P, @Nullable String> nextCursor) {
    Iterator<T> items =
        new Iterator<T>() {
          private @Nullable Iterator<T> page;
          private @Nullable String cursor;
          private boolean last;

          @Override
          public boolean hasNext() {
            while (page == null || !page.hasNext()) {
              if (last) {
                return false;
              }
              P p = fetch.apply(cursor);
              page = data.apply(p).iterator();
              cursor = nextCursor.apply(p);
              Boolean more = hasMore.apply(p);
              last = cursor == null || !(more != null ? more : true);
            }
            return true;
          }

          @Override
          public T next() {
            if (!hasNext()) {
              throw new NoSuchElementException();
            }
            return page.next();
          }
        };
    return StreamSupport.stream(Spliterators.spliteratorUnknownSize(items, Spliterator.ORDERED | Spliterator.NONNULL), false);
  }
}
