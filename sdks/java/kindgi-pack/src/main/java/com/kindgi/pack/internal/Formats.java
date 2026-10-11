// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.net.InetAddress;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/** The string formats a schema may name, checked as {@code ajv-formats} checks them (fast mode). */
final class Formats {
  private Formats() {}

  static final Set<String> KNOWN =
      Set.of("date-time", "date", "time", "uuid", "email", "hostname", "ipv4", "ipv6", "uri", "uri-reference", "regex");

  private static final Pattern DATE = Pattern.compile("^(\\d{4})-(\\d{2})-(\\d{2})$");
  private static final Pattern TIME = Pattern.compile("^(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?([zZ]|[+-]\\d{2}:\\d{2})$");
  private static final Pattern UUID = Pattern.compile("^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", Pattern.CASE_INSENSITIVE);
  private static final Pattern EMAIL =
      Pattern.compile(
          "^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
          Pattern.CASE_INSENSITIVE);
  private static final Pattern HOSTNAME =
      Pattern.compile(
          "^(?=.{1,253}\\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\\.?$",
          Pattern.CASE_INSENSITIVE);
  private static final Pattern URI = Pattern.compile("^[a-z][a-z0-9+\\-.]*:[^\\s]*$", Pattern.CASE_INSENSITIVE);
  private static final Pattern NO_SPACE = Pattern.compile("^[^\\s]*$");
  private static final Pattern IPV4 = Pattern.compile("^(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)$");

  static boolean accepts(String format, String value) {
    switch (format) {
      case "date-time":
        String[] parts = value.split("[tT\\s]", 2);
        return parts.length == 2 && date(parts[0]) && time(parts[1]);
      case "date":
        return date(value);
      case "time":
        return time(value);
      case "uuid":
        return UUID.matcher(value).matches();
      case "email":
        return EMAIL.matcher(value).matches();
      case "hostname":
        return HOSTNAME.matcher(value).matches();
      case "ipv4":
        return IPV4.matcher(value).matches();
      case "ipv6":
        return value.contains(":") && ipv6(value);
      case "uri":
        return URI.matcher(value).matches();
      case "uri-reference":
        return NO_SPACE.matcher(value).matches();
      case "regex":
        try {
          Pattern.compile(value);
          return true;
        } catch (PatternSyntaxException e) {
          return false;
        }
      default:
        return true;
    }
  }

  private static boolean date(String value) {
    Matcher m = DATE.matcher(value);
    if (!m.matches()) {
      return false;
    }
    try {
      LocalDate.of(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
      return true;
    } catch (DateTimeException e) {
      return false;
    }
  }

  private static boolean time(String value) {
    Matcher m = TIME.matcher(value);
    if (!m.matches()) {
      return false;
    }
    int hour = Integer.parseInt(m.group(1));
    int minute = Integer.parseInt(m.group(2));
    int second = Integer.parseInt(m.group(3));
    return hour <= 23 && minute <= 59 && second <= 60;
  }

  private static boolean ipv6(String value) {
    if (!value.matches("^[0-9a-fA-F:.]+$")) {
      return false;
    }
    try {
      return InetAddress.getByName(value).getAddress().length == 16;
    } catch (Exception e) {
      return false;
    }
  }
}
