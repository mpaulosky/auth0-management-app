// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     StubAuth0Handler.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Collections.Specialized;
using System.Net;
using System.Text;
using System.Web;

namespace UI.Tests.Unit.ManagementApi;

/// <summary>
///   One request the stub saw: the verb, the unescaped path, the query and the body.
/// </summary>
internal sealed class RecordedRequest
{
	public RecordedRequest(HttpMethod method, string path, string rawQuery, string body)
	{
		Method = method;
		Path = path;
		RawQuery = rawQuery;
		Query = HttpUtility.ParseQueryString(rawQuery);
		Body = body;
	}

	public HttpMethod Method { get; }

	/// <summary>The absolute path with percent-escapes undone, such as <c>/api/v2/users/auth0|abc</c>.</summary>
	public string Path { get; }

	public string RawQuery { get; }

	public NameValueCollection Query { get; }

	public string Body { get; }
}

/// <summary>
///   Stands in for Auth0 as the <c>"Auth0Management"</c> client's primary handler: it answers <c>/oauth/token</c> with
///   a fixed access token, hands every other request to <see cref="Responder" />, and records them all.
/// </summary>
internal sealed class StubAuth0Handler : HttpMessageHandler
{
	public const string AccessToken = "stub-access-token-0f9d7c41";

	private readonly object _gate = new();
	private readonly List<RecordedRequest> _requests = [];

	public Func<RecordedRequest, CancellationToken, Task<HttpResponseMessage>> Responder { get; set; } =
		(request, _) => throw new InvalidOperationException($"The stub has no response for {request.Method} {request.Path}{request.RawQuery}.");

	public Func<RecordedRequest, HttpResponseMessage> TokenResponder { get; set; } = _ => Auth0Responses.Token(AccessToken);

	public IReadOnlyList<RecordedRequest> Requests
	{
		get
		{
			lock (_gate)
			{
				return [.. _requests];
			}
		}
	}

	/// <summary>Every request to <c>/api/v2/*</c>, retries included.</summary>
	public IReadOnlyList<RecordedRequest> ManagementRequests =>
		[.. Requests.Where(request => request.Path.StartsWith("/api/v2/", StringComparison.Ordinal))];

	public int TokenRequestCount =>
		Requests.Count(request => request.Path.Equals("/oauth/token", StringComparison.Ordinal));

	public void Respond(Func<RecordedRequest, HttpResponseMessage> responder)
	{
		Responder = (request, _) => Task.FromResult(responder(request));
	}

	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(request);

		Uri uri = request.RequestUri ?? throw new InvalidOperationException("The request has no URI.");
		string body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
		RecordedRequest recorded = new(request.Method, Uri.UnescapeDataString(uri.AbsolutePath), uri.Query, body);

		lock (_gate)
		{
			_requests.Add(recorded);
		}

		if (recorded.Path.Equals("/oauth/token", StringComparison.Ordinal))
		{
			return TokenResponder(recorded);
		}

		return await Responder(recorded, cancellationToken);
	}
}

/// <summary>
///   Builders for the responses Auth0's Management API gives, in its wire format.
/// </summary>
internal static class Auth0Responses
{
	public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK)
	{
		return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
	}

	public static HttpResponseMessage Token(string accessToken)
	{
		return Json($$"""{"access_token":"{{accessToken}}","token_type":"Bearer","expires_in":86400}""");
	}

	public static HttpResponseMessage NoContent()
	{
		return new HttpResponseMessage(HttpStatusCode.NoContent);
	}

	public static HttpResponseMessage Error(HttpStatusCode status, string message)
	{
		string error = status switch
		{
			HttpStatusCode.NotFound => "Not Found",
			HttpStatusCode.BadRequest => "Bad Request",
			HttpStatusCode.Conflict => "Conflict",
			HttpStatusCode.Forbidden => "Forbidden",
			HttpStatusCode.ServiceUnavailable => "Service Unavailable",
			(HttpStatusCode)429 => "Too Many Requests",
			_ => "Error",
		};

		return Json($$"""{"statusCode":{{(int)status}},"error":"{{error}}","message":"{{message}}"}""", status);
	}

	/// <summary>
	///   Auth0's 429. <paramref name="resetUnixSeconds" /> is real wall-clock time, because the SDK waits until then
	///   before it retries.
	/// </summary>
	public static HttpResponseMessage RateLimited(long? resetUnixSeconds)
	{
		HttpResponseMessage response = Error((HttpStatusCode)429, "Global limit has been reached");

		if (resetUnixSeconds is not null)
		{
			response.Headers.Add("X-RateLimit-Limit", "2");
			response.Headers.Add("X-RateLimit-Remaining", "0");
			response.Headers.Add("X-RateLimit-Reset", resetUnixSeconds.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
		}

		return response;
	}

	/// <summary>
	///   A User as <c>GET /users/{id}</c> returns them.
	/// </summary>
	public static string User(
		string id = "auth0|abc",
		string connection = "Username-Password-Authentication",
		string provider = "auth0",
		bool isSocial = false)
	{
		return $$"""
			{
			  "user_id": "{{id}}",
			  "name": "Jane Doe",
			  "given_name": "Jane",
			  "family_name": "Doe",
			  "nickname": "jd",
			  "picture": "https://example.test/jane.png",
			  "email": "jane@example.test",
			  "email_verified": true,
			  "last_login": "2026-10-01T12:00:00.000Z",
			  "identities": [
			    { "connection": "{{connection}}", "provider": "{{provider}}", "user_id": "abc", "isSocial": {{(isSocial ? "true" : "false")}} }
			  ]
			}
			""";
	}

	/// <summary>
	///   A page of <c>GET /users</c> with totals.
	/// </summary>
	public static string UsersPage(int total, params string[] userIds)
	{
		string users = string.Join(",", userIds.Select(id => $$"""
			{ "user_id": "{{id}}", "name": "Name {{id}}", "email": "{{id.Replace("|", "-", StringComparison.Ordinal)}}@example.test", "picture": "https://example.test/p.png",
			  "identities": [ { "connection": "Username-Password-Authentication", "provider": "auth0", "user_id": "x", "isSocial": false } ] }
			"""));

		return $$"""{"start":0,"limit":{{userIds.Length}},"length":{{userIds.Length}},"total":{{total}},"users":[{{users}}]}""";
	}

	/// <summary>
	///   The offset-paged Role list an endpoint returns, answering with the page that <paramref name="request" /> asks for
	///   (empty once past the last page), in the shape that matches <c>include_totals</c>.
	/// </summary>
	public static HttpResponseMessage RolesPage(RecordedRequest request, params string[][] pages)
	{
		ArgumentNullException.ThrowIfNull(request);

		int index = int.Parse(request.Query["page"] ?? "0", System.Globalization.CultureInfo.InvariantCulture);
		string[] ids = index < pages.Length ? pages[index] : [];
		string roles = string.Join(",", ids.Select(id =>
			$$"""{ "id": "{{id}}", "name": "Role {{id}}", "description": "About {{id}}" }"""));
		int total = pages.Sum(page => page.Length);

		bool includeTotals = string.Equals(request.Query["include_totals"], "true", StringComparison.OrdinalIgnoreCase);

		return Json(includeTotals
			? $$"""{"start":{{index}},"limit":50,"total":{{total}},"roles":[{{roles}}]}"""
			: $"[{roles}]");
	}

	/// <summary>
	///   A checkpoint-paged page of <c>GET /roles/{id}/users</c>. A <see langword="null" /> <paramref name="next" />
	///   is the last page.
	/// </summary>
	public static HttpResponseMessage RoleUsersPage(IEnumerable<string> userIds, string? next)
	{
		string users = string.Join(",", userIds.Select(id =>
			$$"""{ "user_id": "{{id}}", "name": "Name {{id}}", "email": "{{id.Replace("|", "-", StringComparison.Ordinal)}}@example.test", "picture": "https://example.test/p.png" }"""));
		string nextProperty = next is null ? string.Empty : $$""","next":"{{next}}" """;

		return Json($$"""{"users":[{{users}}]{{nextProperty}}}""");
	}
}
