// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UserSearchQueryBuilder.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Text;

namespace UI.Components.Features.Users;

/// <summary>
///   Turns the search box's text into the Lucene query Auth0's User search takes.
/// </summary>
public static class UserSearchQueryBuilder
{
	// Lucene's special characters, plus = which Elasticsearch's query_string reads as reserved. && and || are escaped one
	// character at a time, which Lucene reads the same way.
	private const string SpecialCharacters = "+-&|!(){}[]^\"~*?:\\/=";

	/// <summary>
	///   Builds the query for the text in the search box.
	/// </summary>
	/// <param name="input">The raw search box text.</param>
	/// <returns>The Lucene query, or <see langword="null" /> when the box is empty and every User should list.</returns>
	public static string? Build(string? input)
	{
		// < and > can't be escaped in Elasticsearch, and unescaped they open a range query instead of a prefix match, so
		// they separate words like whitespace does.
		// Auth0's normalized fields match regardless of case, but Lucene engines often skip normalizing a prefix term, so
		// name:Jane* can miss where name:jane* matches. Lower case is what Auth0 compares against, not a round-trip key.
#pragma warning disable CA1308
		string text = input?.Replace('<', ' ').Replace('>', ' ').Trim().ToLowerInvariant() ?? string.Empty;
#pragma warning restore CA1308
		if (text.Length == 0)
		{
			return null;
		}

		// A run of whitespace becomes one escaped space, so "Jane Doe" stays one prefix term: v3 doesn't split a field's
		// value into words, so name:doe* would never match "Jane Doe".
		StringBuilder term = new(text.Length * 2);
		bool inWhitespace = false;
		foreach (char character in text)
		{
			if (char.IsWhiteSpace(character))
			{
				if (!inWhitespace)
				{
					term.Append(@"\ ");
				}

				inWhitespace = true;

				continue;
			}

			inWhitespace = false;
			if (SpecialCharacters.Contains(character, StringComparison.Ordinal))
			{
				term.Append('\\');
			}

			term.Append(character);
		}

		return $"email:{term}* OR name:{term}* OR given_name:{term}* OR family_name:{term}*";
	}
}
