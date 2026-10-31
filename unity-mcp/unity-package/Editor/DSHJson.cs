using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DSHUnityBridge
{
    /// <summary>Minimal JSON reader/writer (no external dependencies).</summary>
    public static class DSHJson
    {
        public static object Deserialize(string json)
        {
            if (json == null) throw new ArgumentNullException("json");
            var p = new Parser(json);
            object v = p.ParseValue();
            p.SkipWhitespace();
            if (!p.AtEnd) throw new FormatException("Unexpected trailing characters at " + p.Position);
            return v;
        }

        public static string Serialize(object value)
        {
            var sb = new StringBuilder(256);
            Write(sb, value);
            return sb.ToString();
        }

        static void Write(StringBuilder sb, object value)
        {
            if (value == null) { sb.Append("null"); return; }
            if (value is string) { WriteString(sb, (string)value); return; }
            if (value is bool) { sb.Append(((bool)value) ? "true" : "false"); return; }
            if (value is char) { WriteString(sb, value.ToString()); return; }
            if (value is float) { WriteNumber(sb, Convert.ToDouble(value)); return; }
            if (value is double) { WriteNumber(sb, (double)value); return; }
            if (value is decimal) { WriteNumber(sb, (double)(decimal)value); return; }
            if (value is sbyte || value is byte || value is short || value is ushort ||
                value is int || value is uint || value is long || value is ulong)
            {
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }
            var dict = value as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry e in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, Convert.ToString(e.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    Write(sb, e.Value);
                }
                sb.Append('}');
                return;
            }
            var en = value as IEnumerable;
            if (en != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (object item in en)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item);
                }
                sb.Append(']');
                return;
            }
            WriteString(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            if (d == Math.Floor(d) && Math.Abs(d) < 1e15) sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
            else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x7f) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        sealed class Parser
        {
            readonly string s;
            int i;
            public Parser(string text) { s = text; }
            public int Position { get { return i; } }
            public bool AtEnd { get { return i >= s.Length; } }

            public void SkipWhitespace()
            {
                while (i < s.Length)
                {
                    char c = s[i];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                    else break;
                }
            }

            public object ParseValue()
            {
                SkipWhitespace();
                if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
                char c = s[i];
                switch (c)
                {
                    case '{': return ParseObject();
                    case '[': return ParseArray();
                    case '"': return ParseString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                        throw new FormatException("Unexpected character '" + c + "' at " + i);
                }
            }

            Dictionary<string, object> ParseObject()
            {
                var d = new Dictionary<string, object>(StringComparer.Ordinal);
                i++; // {
                SkipWhitespace();
                if (i < s.Length && s[i] == '}') { i++; return d; }
                while (true)
                {
                    SkipWhitespace();
                    if (i >= s.Length || s[i] != '"') throw new FormatException("Expected object key at " + i);
                    string key = ParseString();
                    SkipWhitespace();
                    if (i >= s.Length || s[i] != ':') throw new FormatException("Expected ':' at " + i);
                    i++;
                    d[key] = ParseValue();
                    SkipWhitespace();
                    if (i >= s.Length) throw new FormatException("Unterminated object");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return d; }
                    throw new FormatException("Expected ',' or '}' at " + i);
                }
            }

            List<object> ParseArray()
            {
                var list = new List<object>();
                i++; // [
                SkipWhitespace();
                if (i < s.Length && s[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ParseValue());
                    SkipWhitespace();
                    if (i >= s.Length) throw new FormatException("Unterminated array");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return list; }
                    throw new FormatException("Expected ',' or ']' at " + i);
                }
            }

            string ParseString()
            {
                i++; // opening quote
                var sb = new StringBuilder();
                while (i < s.Length)
                {
                    char c = s[i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (i >= s.Length) throw new FormatException("Unterminated escape");
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 > s.Length) throw new FormatException("Bad unicode escape");
                            sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                            i += 4;
                            break;
                        default: throw new FormatException("Bad escape \\" + e);
                    }
                }
                throw new FormatException("Unterminated string");
            }

            object ParseNumber()
            {
                int start = i;
                if (s[i] == '-') i++;
                while (i < s.Length && char.IsDigit(s[i])) i++;
                bool isFloat = false;
                if (i < s.Length && s[i] == '.') { isFloat = true; i++; while (i < s.Length && char.IsDigit(s[i])) i++; }
                if (i < s.Length && (s[i] == 'e' || s[i] == 'E')) { isFloat = true; i++; if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++; while (i < s.Length && char.IsDigit(s[i])) i++; }
                string text = s.Substring(start, i - start);
                if (!isFloat)
                {
                    long l;
                    if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out l)) return l;
                }
                double d;
                if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
                throw new FormatException("Bad number '" + text + "'");
            }

            void Expect(string literal)
            {
                if (i + literal.Length > s.Length || string.CompareOrdinal(s, i, literal, 0, literal.Length) != 0)
                    throw new FormatException("Expected '" + literal + "' at " + i);
                i += literal.Length;
            }
        }
    }
}
