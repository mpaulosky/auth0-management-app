// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiAdapter.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;

using Auth0.Core.Exceptions;
using Auth0.ManagementApi;
using Auth0.ManagementApi.Core;
using Auth0.ManagementApi.Roles;
using Auth0.ManagementApi.Users;

using Domain.Abstractions;

using Microsoft.Extensions.Options;

namespace UI.ManagementApi;

/// <summary>
///   Translates <see cref="IManagementApi" /> calls into the <c>Auth0.ManagementApi</c> SDK's: it pages, maps the
///   SDK's failures to stable error codes by status code, and builds our own records.
/// </summary>
[SuppressMessage("Performance", "CA1812:Avoid uninstantiated internal classes",
	Justification = "AddManagementApi() registers it, and the container instantiates it.")]
internal sealed partial class ManagementApiAdapter : IManagementApi
{
	/// <summary>The named <see cref="HttpClient" /> every Management API and token request goes through.</summary>
	public const string HttpClientName = "Auth0Management";

	/// <summary>The most members <see cref="ListRoleMembersAsync" /> fetches: ten checkpoint pages.</summary>
	public const int MemberCap = 1000;

	/// <summary>The most Users Auth0 lets a search reach: <c>page * per_page</c> can't pass it.</summary>
	public const int SearchWindow = 1000;

	/// <summary>The largest page size Auth0 accepts for a User search.</summary>
	public const int MaxSearchPerPage = 100;

	private const int MemberPageSize = 100;
	private const int RolePageSize = 50;
	private const string SettingsHint =
		"Check the Auth0:Management:Domain, Auth0:Management:ClientId and Auth0:Management:ClientSecret settings, and that the Machine to Machine application has the permissions in the README's permission table.";

	private static readonly TimeSpan ClientTimeout = TimeSpan.FromSeconds(10);

	private readonly IHttpClientFactory _httpClientFactory;
	private readonly ILogger<ManagementApiAdapter> _logger;
	private readonly ManagementApiOptions _options;
	private readonly TimeProvider _timeProvider;
	private readonly ITokenProvider _tokenProvider;

	/// <summary>
	///   Initializes a new instance of the <see cref="ManagementApiAdapter" /> class.
	/// </summary>
	/// <param name="tokenProvider">The singleton that caches the client-credentials token.</param>
	/// <param name="httpClientFactory">The factory for the <c>"Auth0Management"</c> client.</param>
	/// <param name="options">The Management API settings.</param>
	/// <param name="timeProvider">The clock the rate-limit message counts down against.</param>
	/// <param name="logger">The logger for configuration and outage failures.</param>
	public ManagementApiAdapter(ITokenProvider tokenProvider, IHttpClientFactory httpClientFactory,
		IOptions<ManagementApiOptions> options, TimeProvider timeProvider, ILogger<ManagementApiAdapter> logger)
	{
		ArgumentNullException.ThrowIfNull(tokenProvider);
		ArgumentNullException.ThrowIfNull(httpClientFactory);
		ArgumentNullException.ThrowIfNull(options);
		ArgumentNullException.ThrowIfNull(timeProvider);
		ArgumentNullException.ThrowIfNull(logger);

		_tokenProvider = tokenProvider;
		_httpClientFactory = httpClientFactory;
		_options = options.Value;
		_timeProvider = timeProvider;
		_logger = logger;
	}

	/// <inheritdoc />
	public Task<Result<UserPage>> SearchUsersAsync(UserSearch search, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(search);
		ArgumentOutOfRangeException.ThrowIfLessThan(search.Page, 1);
		ArgumentOutOfRangeException.ThrowIfLessThan(search.PerPage, 1);
		ArgumentOutOfRangeException.ThrowIfGreaterThan(search.PerPage, MaxSearchPerPage);

		// Auth0 answers a 400 for a page past its search window, which would read as "invalid search text" below. The
		// Users slice clamps the page before it asks (see the plan's "The 1000 cap"), so reaching here is a caller bug.
		ArgumentOutOfRangeException.ThrowIfGreaterThan((long)search.Page * search.PerPage, SearchWindow);

		return CallAsync(nameof(SearchUsersAsync), async (client, token) =>
		{
			ListUsersRequestParameters request = new()
			{
				Page = search.Page - 1,
				PerPage = search.PerPage,
				IncludeTotals = true,
				SearchEngine = SearchEngineVersionsEnum.V3,
				Sort = "name:1",
			};

			if (search.Query is not null)
			{
				request.Q = search.Query;
			}

			Pager<UserResponseSchema> pager = await client.Users.ListAsync(request, cancellationToken: token)
				.ConfigureAwait(false);
			double? total = (pager.CurrentPage.Response as ListUsersOffsetPaginatedResponseContent)?.Total;

			return new UserPage([.. pager.CurrentPage.Items.Select(ToSummary)], (int)(total ?? 0));
		}, exception => exception.StatusCode switch
		{
			400 => ManagementApiError.SearchInvalid,
			503 => ManagementApiError.SearchTooBroad,
			_ => null,
		}, cancellationToken);
	}

	/// <inheritdoc />
	public Task<Result<UserDetails>> GetUserAsync(string userId, CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(userId);

		return CallAsync(nameof(GetUserAsync), async (client, token) =>
		{
			GetUserResponseContent user = await client.Users.GetAsync(userId, new GetUserRequestParameters(),
				cancellationToken: token).ConfigureAwait(false);
			List<RoleSummary> roles = [];

			await foreach (Role role in UserRolesAsync(client, userId, token).ConfigureAwait(false))
			{
				roles.Add(ToSummary(role));
			}

			UserIdentitySchema? identity = user.Identities?.FirstOrDefault();

			return new UserDetails(
				user.UserId ?? userId,
				user.Name,
				user.GivenName,
				user.FamilyName,
				user.Nickname,
				user.Picture,
				user.Email,
				user.EmailVerified ?? false,
				identity?.Connection,
				ToDateTimeOffset(user.LastLogin),
				EditableFieldsOf(identity),
				roles);
		}, UserNotFoundOn404, cancellationToken);
	}

	/// <inheritdoc />
	public async Task<Result> UpdateProfileFieldsAsync(string userId, ProfileFieldsChange change,
		CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(userId);
		ArgumentNullException.ThrowIfNull(change);

		return await CallAsync(nameof(UpdateProfileFieldsAsync), async (client, token) =>
		{
			await client.Users.UpdateAsync(userId, ToRequest(change), cancellationToken: token).ConfigureAwait(false);

			return true;
		}, exception => exception.StatusCode switch
		{
			404 => ManagementApiError.UserNotFound,
			409 => ManagementApiError.EmailInUse,
			400 => ManagementApiError.FieldNotEditable(exception.Description ?? exception.Message),
			_ => null,
		}, cancellationToken).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public async Task<Result> AssignRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(userId);
		ArgumentException.ThrowIfNullOrWhiteSpace(roleId);

		return await CallAsync(nameof(AssignRoleAsync), async (client, token) =>
		{
			await client.Users.Roles.AssignAsync(userId, new AssignUserRolesRequestContent { Roles = [roleId] },
				cancellationToken: token).ConfigureAwait(false);

			return true;
		}, UserOrRoleNotFoundOn404, cancellationToken).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public async Task<Result> RemoveRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(userId);
		ArgumentException.ThrowIfNullOrWhiteSpace(roleId);

		return await CallAsync(nameof(RemoveRoleAsync), async (client, token) =>
		{
			await client.Users.Roles.DeleteAsync(userId, new DeleteUserRolesRequestContent { Roles = [roleId] },
				cancellationToken: token).ConfigureAwait(false);

			return true;
		}, UserOrRoleNotFoundOn404, cancellationToken).ConfigureAwait(false);
	}

	/// <inheritdoc />
	public Task<Result<IReadOnlyList<RoleSummary>>> ListRolesAsync(CancellationToken cancellationToken)
	{
		return CallAsync<IReadOnlyList<RoleSummary>>(nameof(ListRolesAsync), async (client, token) =>
		{
			ListRolesRequestParameters request = new() { PerPage = RolePageSize, IncludeTotals = true };
			Pager<Role> pager = await client.Roles.ListAsync(request, cancellationToken: token).ConfigureAwait(false);
			List<RoleSummary> roles = [];

			await foreach (Page<Role> page in OffsetPagesAsync(pager,
				response => (response as ListRolesOffsetPaginatedResponseContent)?.Total, token).ConfigureAwait(false))
			{
				roles.AddRange(page.Items.Select(ToSummary));
			}

			return roles;
		}, static _ => null, cancellationToken);
	}

	/// <inheritdoc />
	public Task<Result<RoleSummary>> CreateRoleAsync(NewRole role, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(role);

		return CallAsync(nameof(CreateRoleAsync), async (client, token) =>
		{
			CreateRoleResponseContent created = await client.Roles.CreateAsync(
				new CreateRoleRequestContent { Name = role.Name, Description = role.Description },
				cancellationToken: token).ConfigureAwait(false);

			return new RoleSummary(created.Id ?? string.Empty, created.Name ?? role.Name, created.Description);
		}, static exception => exception.StatusCode == 409 ? ManagementApiError.RoleAlreadyExists : null,
			cancellationToken);
	}

	/// <inheritdoc />
	public Task<Result<RoleMembers>> ListRoleMembersAsync(string roleId, CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(roleId);

		return CallAsync(nameof(ListRoleMembersAsync), async (client, token) =>
		{
			Pager<RoleUser> pager = await FirstMemberPageAsync(client, roleId, token).ConfigureAwait(false);
			List<UserSummary> members = [.. pager.CurrentPage.Items.Select(ToSummary)];

			while (pager.HasNextPage && members.Count < MemberCap)
			{
				Page<RoleUser> page = await pager.GetNextPageAsync(token).ConfigureAwait(false);
				members.AddRange(page.Items.Select(ToSummary));
			}

			bool truncated = members.Count > MemberCap || (members.Count == MemberCap && pager.HasNextPage);

			return new RoleMembers(members.Count > MemberCap ? members.GetRange(0, MemberCap) : members, truncated);
		}, RoleNotFoundOn404, cancellationToken);
	}

	/// <inheritdoc />
	public Task<Result<int>> CountRoleMembersAsync(string roleId, int atMost, CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(roleId);
		ArgumentOutOfRangeException.ThrowIfNegative(atMost);

		return CallAsync(nameof(CountRoleMembersAsync), async (client, token) =>
		{
			if (atMost == 0)
			{
				return 0;
			}

			Pager<RoleUser> pager = await FirstMemberPageAsync(client, roleId, token).ConfigureAwait(false);
			int count = pager.CurrentPage.Items.Count;

			while (count < atMost && pager.HasNextPage)
			{
				Page<RoleUser> page = await pager.GetNextPageAsync(token).ConfigureAwait(false);
				count += page.Items.Count;
			}

			return Math.Min(count, atMost);
		}, RoleNotFoundOn404, cancellationToken);
	}

	/// <inheritdoc />
	public Task<Result<bool>> UserHoldsRoleAsync(string userId, string roleId, CancellationToken cancellationToken)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(userId);
		ArgumentException.ThrowIfNullOrWhiteSpace(roleId);

		return CallAsync(nameof(UserHoldsRoleAsync), async (client, token) =>
		{
			await foreach (Role role in UserRolesAsync(client, userId, token).ConfigureAwait(false))
			{
				if (string.Equals(role.Id, roleId, StringComparison.Ordinal))
				{
					return true;
				}
			}

			return false;
		}, UserNotFoundOn404, cancellationToken);
	}

	// Runs one IManagementApi call on a fresh ManagementClient. Expected failures become a failed Result; anything the
	// catalogue doesn't list is a misconfiguration or an outage, so it's logged at Error and thrown.
	private async Task<Result<T>> CallAsync<T>(string operation,
		Func<ManagementClient, CancellationToken, Task<T>> call,
		Func<ManagementApiException, ManagementApiError?> mapExpected,
		CancellationToken cancellationToken)
	{
		using RateLimitMark mark = RateLimitMark.Begin();
		using ManagementClient client = CreateClient();

		try
		{
			return Result.Ok(await call(client, cancellationToken).ConfigureAwait(false));
		}
		catch (ManagementApiException exception) when (exception.StatusCode == 429)
		{
			LogRateLimited(operation);

			return ManagementApiError.RateLimited(exception.RateLimit?.Reset, _timeProvider.GetUtcNow()).ToResult<T>();
		}
		catch (ManagementApiException exception) when (exception.StatusCode >= 500 && mark.MetRateLimit)
		{
			// The request's retry met a 429 first, so the 5xx is most likely Auth0 shedding load, not an outage. This
			// precedes mapExpected, which maps a 503 on the search to "too broad". The exception stays in the log.
			LogRateLimitedByFailure(exception, operation, exception.StatusCode);

			return ManagementApiError.RateLimited(null, _timeProvider.GetUtcNow()).ToResult<T>();
		}
		catch (ManagementApiException exception) when (mapExpected(exception) is { } error)
		{
			return error.ToResult<T>();
		}
		catch (ManagementApiException exception) when (exception.StatusCode is 401 or 403)
		{
			LogRefused(exception, operation, exception.StatusCode, SettingsHint);

			throw;
		}
		catch (ManagementApiException exception)
		{
			LogFailed(exception, operation, exception.StatusCode);

			throw;
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && mark.MetRateLimit)
		{
			// The SDK's timeout fired on a call that was waiting out a rate limit, not on an outage.
			LogRateLimited(operation);

			return ManagementApiError.RateLimited(null, _timeProvider.GetUtcNow()).ToResult<T>();
		}
		catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
		{
			LogTimedOut(exception, operation);

			throw;
		}
		catch (ApiException exception)
		{
			LogTokenExchangeFailed(exception, operation, SettingsHint);

			throw;
		}
		catch (HttpRequestException exception) when (!cancellationToken.IsCancellationRequested)
		{
			// A DNS failure or refused connection, from the token exchange or a request: most likely a mistyped Domain.
			LogUnreachable(exception, operation, SettingsHint);

			throw;
		}
	}

	private ManagementClient CreateClient()
	{
		return new ManagementClient(new ManagementClientOptions
		{
			Domain = _options.Domain,
			TokenProvider = _tokenProvider,
			HttpClient = _httpClientFactory.CreateClient(HttpClientName),
			MaxRetries = 1,
			Timeout = ClientTimeout,
		});
	}

	private static Task<Pager<RoleUser>> FirstMemberPageAsync(ManagementClient client, string roleId,
		CancellationToken cancellationToken)
	{
		return client.Roles.Users.ListAsync(roleId, new ListRoleUsersRequestParameters { Take = MemberPageSize },
			cancellationToken: cancellationToken);
	}

	private static async IAsyncEnumerable<Role> UserRolesAsync(ManagementClient client, string userId,
		[EnumeratorCancellation] CancellationToken cancellationToken)
	{
		ListUserRolesRequestParameters request = new() { PerPage = RolePageSize, IncludeTotals = true };
		Pager<Role> pager = await client.Users.Roles.ListAsync(userId, request, cancellationToken: cancellationToken)
			.ConfigureAwait(false);

		await foreach (Page<Role> page in OffsetPagesAsync(pager,
			response => (response as ListUserRolesOffsetPaginatedResponseContent)?.Total, cancellationToken)
			.ConfigureAwait(false))
		{
			foreach (Role role in page.Items)
			{
				yield return role;
			}
		}
	}

	// An offset pager asks for pages until one comes back empty. Stopping once Auth0's total has been seen saves that
	// last empty request, which every listing would otherwise spend from the rate limit.
	private static async IAsyncEnumerable<Page<TItem>> OffsetPagesAsync<TItem>(Pager<TItem> pager,
		Func<object?, double?> totalOf,
		[EnumeratorCancellation] CancellationToken cancellationToken)
	{
		Page<TItem> page = pager.CurrentPage;
		int seen = 0;

		while (true)
		{
			yield return page;

			seen += page.Items.Count;
			double? total = totalOf(page.Response);

			if (page.Items.Count == 0 || (total is not null && seen >= total) || !pager.HasNextPage)
			{
				yield break;
			}

			page = await pager.GetNextPageAsync(cancellationToken).ConfigureAwait(false);
		}
	}

	private static UpdateUserRequestContent ToRequest(ProfileFieldsChange change)
	{
		UpdateUserRequestContent request = new()
		{
			Name = OptionalOf(change.Name),
			GivenName = OptionalOf(change.GivenName),
			FamilyName = OptionalOf(change.FamilyName),
			Nickname = OptionalOf(change.Nickname),
			Picture = OptionalOf(change.Picture),
		};

		if (change.Email is not null)
		{
			// A changed address is unverified, and Admins don't trigger a verification email.
			request.Email = OptionalOf(change.Email);
			request.EmailVerified = false;
			request.VerifyEmail = false;
		}

		return request;
	}

	// An undefined Optional is left out of the body; one holding null sends an explicit null, which clears the field.
	private static Optional<string?> OptionalOf(string? value)
	{
		return value switch
		{
			null => Optional<string?>.Undefined,
			"" => Optional<string?>.Of(null),
			_ => Optional<string?>.Of(value),
		};
	}

	// Assumes Auth0's default "Sync user profile attributes at each login": the app has no read:connections permission
	// to check a connection's setting, so a social or enterprise User is always shown as locked.
	private static ProfileField EditableFieldsOf(UserIdentitySchema? identity)
	{
		const ProfileField allButEmail = ProfileField.Name | ProfileField.GivenName | ProfileField.FamilyName |
			ProfileField.Nickname | ProfileField.Picture;

		return identity?.Provider?.Value switch
		{
			"auth0" => allButEmail | ProfileField.Email,
			"email" or "sms" => allButEmail,
			_ => ProfileField.None,
		};
	}

	private static ManagementApiError? UserNotFoundOn404(ManagementApiException exception)
	{
		return exception.StatusCode == 404 ? ManagementApiError.UserNotFound : null;
	}

	private static ManagementApiError? RoleNotFoundOn404(ManagementApiException exception)
	{
		return exception.StatusCode == 404 ? ManagementApiError.RoleNotFound : null;
	}

	// The same 404 covers a missing User and a missing Role, so Auth0's message tells them apart.
	private static ManagementApiError? UserOrRoleNotFoundOn404(ManagementApiException exception)
	{
		if (exception.StatusCode != 404)
		{
			return null;
		}

		string message = exception.Description ?? exception.Message;

		return message.Contains("role", StringComparison.OrdinalIgnoreCase)
			? ManagementApiError.RoleNotFound
			: ManagementApiError.UserNotFound;
	}

	private static UserSummary ToSummary(UserResponseSchema user)
	{
		return new UserSummary(user.UserId ?? string.Empty, user.Name, user.Email, user.Picture,
			user.Identities?.FirstOrDefault()?.Connection);
	}

	private static UserSummary ToSummary(RoleUser user)
	{
		return new UserSummary(user.UserId ?? string.Empty, user.Name, user.Email, user.Picture, null);
	}

	private static RoleSummary ToSummary(Role role)
	{
		return new RoleSummary(role.Id ?? string.Empty, role.Name ?? string.Empty, role.Description);
	}

	private static DateTimeOffset? ToDateTimeOffset(DateTime? value)
	{
		return value switch
		{
			null => null,
			{ Kind: DateTimeKind.Local } local => new DateTimeOffset(local),
			{ } other => new DateTimeOffset(DateTime.SpecifyKind(other, DateTimeKind.Utc)),
		};
	}

	[LoggerMessage(Level = LogLevel.Warning, Message = "Auth0 is rate limiting the Management API call {Operation}")]
	private partial void LogRateLimited(string operation);

	[LoggerMessage(Level = LogLevel.Error,
		Message = "Auth0 refused the Management API call {Operation} with status {StatusCode}. {Hint}")]
	private partial void LogRefused(Exception exception, string operation, int statusCode, string hint);

	[LoggerMessage(Level = LogLevel.Error, Message = "The Management API call {Operation} failed with status {StatusCode}")]
	private partial void LogFailed(Exception exception, string operation, int statusCode);

	[LoggerMessage(Level = LogLevel.Error, Message = "The Management API call {Operation} timed out")]
	private partial void LogTimedOut(Exception exception, string operation);

	[LoggerMessage(Level = LogLevel.Warning,
		Message = "Auth0 is rate limiting the Management API call {Operation}, and its retry failed with status {StatusCode}")]
	private partial void LogRateLimitedByFailure(Exception exception, string operation, int statusCode);

	[LoggerMessage(Level = LogLevel.Error,
		Message = "The Management API call {Operation} couldn't reach Auth0. {Hint}")]
	private partial void LogUnreachable(Exception exception, string operation, string hint);

	[LoggerMessage(Level = LogLevel.Error,
		Message = "The Management API call {Operation} couldn't get an access token from Auth0. {Hint}")]
	private partial void LogTokenExchangeFailed(Exception exception, string operation, string hint);
}
