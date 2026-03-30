import SwiftUI

/// Markdown renderer ported from companion app.
/// Supports code blocks, tables, lists, headings, quotes, and inline formatting.
struct MarkdownTextView: View {
    let text: String
    let foregroundColor: Color

    init(_ text: String, foregroundColor: Color = .primary) {
        self.text = text
        self.foregroundColor = foregroundColor
    }

    var body: some View {
        let blocks = Self.parseBlocks(text)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .paragraph(let text):
            inlineMarkdown(text)

        case .codeBlock(let code, _):
            Text(verbatim: code)
                .font(.system(.callout, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.systemGray4).opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 8))

        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color(.systemGray2))
                    .frame(width: 3)
                inlineMarkdown(text)
                    .foregroundStyle(.secondary)
            }

        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\u{2022}")
                        inlineMarkdown(item)
                    }
                }
            }

        case .orderedList(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(i + 1).")
                            .monospacedDigit()
                        inlineMarkdown(item)
                    }
                }
            }

        case .heading(let text, let level):
            inlineMarkdown(text)
                .font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())

        case .table(let headers, let rows):
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                        inlineMarkdown(header)
                            .fontWeight(.semibold)
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            inlineMarkdown(cell)
                        }
                    }
                }
            }
            .font(.callout)
        }
    }

    // Dollar sign placeholder to prevent LaTeX math interpretation
    private static let dollarPlaceholder = "\u{FFFC}\u{200B}D\u{200B}\u{FFFC}"

    @ViewBuilder
    private func inlineMarkdown(_ str: String) -> some View {
        let safe = str.replacingOccurrences(of: "$", with: Self.dollarPlaceholder)
        if let attributed = try? AttributedString(
            markdown: safe,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            let withLinks = Self.addDataDetectorLinks(to: attributed)
            let restored = Self.restorePlaceholder(in: withLinks)
            Text(restored)
                .foregroundStyle(foregroundColor)
        } else {
            Text(Self.addDataDetectorLinks(to: AttributedString(str)))
                .foregroundStyle(foregroundColor)
        }
    }

    private static func restorePlaceholder(in input: AttributedString) -> AttributedString {
        let ns = NSMutableAttributedString(input)
        let placeholderNS = dollarPlaceholder as NSString
        var searchRange = NSRange(location: 0, length: ns.length)
        while true {
            let found = (ns.string as NSString).range(of: placeholderNS as String, range: searchRange)
            if found.location == NSNotFound { break }
            ns.replaceCharacters(in: found, with: "$")
            searchRange = NSRange(location: found.location + 1, length: ns.length - found.location - 1)
        }
        return AttributedString(ns)
    }

    private static func addDataDetectorLinks(to input: AttributedString) -> AttributedString {
        var result = input
        let plainText = String(result.characters)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue
            | NSTextCheckingResult.CheckingType.phoneNumber.rawValue
        ) else { return result }

        let nsRange = NSRange(plainText.startIndex..., in: plainText)
        let matches = detector.matches(in: plainText, range: nsRange)

        for match in matches {
            guard let swiftRange = Range(match.range, in: plainText),
                  let attrRange = result.range(of: plainText[swiftRange]) else { continue }

            if let url = match.url {
                result[attrRange].link = url
            } else if match.resultType == .phoneNumber, let phone = match.phoneNumber {
                result[attrRange].link = URL(string: "tel:\(phone.replacingOccurrences(of: " ", with: ""))")
            }
        }
        return result
    }

    // MARK: - Parser

    private enum Block {
        case paragraph(String)
        case codeBlock(String, String?)
        case quote(String)
        case bulletList([String])
        case orderedList([String])
        case heading(String, Int)
        case table([String], [[String]])
    }

    private static func parseBlocks(_ text: String) -> [Block] {
        var blocks: [Block] = []
        let lines = text.components(separatedBy: "\n")
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty { i += 1; continue }

            // Code block
            if trimmed.hasPrefix("```") {
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                i += 1
                while i < lines.count {
                    if lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { i += 1; break }
                    codeLines.append(lines[i])
                    i += 1
                }
                blocks.append(.codeBlock(codeLines.joined(separator: "\n"), language.isEmpty ? nil : language))
                continue
            }

            // Heading
            if let m = trimmed.wholeMatch(of: /^(#{1,3})\s+(.+)/) {
                blocks.append(.heading(String(m.2), m.1.count))
                i += 1; continue
            }

            // Table
            if trimmed.hasPrefix("|") && trimmed.hasSuffix("|") {
                var tableLines: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if l.hasPrefix("|") { tableLines.append(l) } else { break }
                    i += 1
                }
                if tableLines.count >= 2 {
                    let parseCells = { (line: String) -> [String] in
                        line.split(separator: "|", omittingEmptySubsequences: false)
                            .dropFirst().dropLast()
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                    }
                    let headers = parseCells(tableLines[0])
                    let startRow = tableLines.count > 2 && tableLines[1].contains("-") ? 2 : 1
                    let rows = tableLines[startRow...].map { parseCells($0) }
                    blocks.append(.table(headers, Array(rows)))
                }
                continue
            }

            // Block quote
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if l.hasPrefix(">") { quoteLines.append(String(l.dropFirst()).trimmingCharacters(in: .whitespaces)) }
                    else if l.isEmpty { break } else { break }
                    i += 1
                }
                blocks.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            // Bullet list
            if trimmed.wholeMatch(of: /^[-*]\s+.+/) != nil {
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if let m = l.wholeMatch(of: /^[-*]\s+(.+)/) { items.append(String(m.1)) }
                    else if l.isEmpty { break }
                    else { if !items.isEmpty { items[items.count - 1] += " " + l } }
                    i += 1
                }
                blocks.append(.bulletList(items))
                continue
            }

            // Ordered list
            if trimmed.wholeMatch(of: /^\d+\.\s+.+/) != nil {
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if let m = l.wholeMatch(of: /^\d+\.\s+(.+)/) { items.append(String(m.1)) }
                    else if l.isEmpty { break }
                    else { if !items.isEmpty { items[items.count - 1] += " " + l } }
                    i += 1
                }
                blocks.append(.orderedList(items))
                continue
            }

            // Paragraph
            var paraLines: [String] = []
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                if t.isEmpty || t.hasPrefix("```") || t.hasPrefix("#") || t.hasPrefix(">")
                    || (t.hasPrefix("|") && t.hasSuffix("|"))
                    || t.wholeMatch(of: /^[-*]\s+.+/) != nil
                    || t.wholeMatch(of: /^\d+\.\s+.+/) != nil { break }
                paraLines.append(lines[i])
                i += 1
            }
            if !paraLines.isEmpty {
                blocks.append(.paragraph(paraLines.joined(separator: "\n")))
            } else {
                i += 1 // Skip to avoid infinite loop
            }
        }
        return blocks
    }
}
