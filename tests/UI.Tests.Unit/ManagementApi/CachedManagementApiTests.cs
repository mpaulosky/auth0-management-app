// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     CachedManagementApiTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Net;
using System.Threading.RateLimiting;

using Domain.Abstractions;

using Microsoft.Extensions.DependencyInjection;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class CachedManagementApiTests
{
	private const string OtherUserId = "auth0|other";
	private const string OtherRoleId = "rol_user";

	private static CancellationToken Ct => Xunit.TestContext.Current.CancellationToken;

	public static TheoryData<string, int> ReadLifetimes => new()
	{
		{ "SearchUsers", 30 },
		{ "GetUser", 60 },
		{ "ListRoles", 300 },
		{ "ListRoleMembers", 60 },
	};

	public static TheoryData<string> CachedReads => ["SearchUsers", "GetUser", "ListRoles", "ListRoleMembers"];

	public static TheoryData<string> UncachedCalls =>
		["CountRoleMembers", "UserHoldsRole", "UpdateProfileFields", "AssignRole", "RemoveRole", "CreateRole"];

	private static Task<Result> ReadAsync(IManagementApi api, string read)
	{
		return ReadAsync(api, read, ApiCalls.UserId, ApiCalls.RoleId);
	}

	private static async Task<Result> ReadAsync(IManagementApi api, string read, string userId, string roleId)
	{
		Result result = read switch
		{
			"SearchUsers" => await api.SearchUsersAsync(new UserSearch("jane", 1, 25), Ct),
			"GetUser" => await api.GetUserAsync(userId, Ct),
			"ListRoles" => await api.ListRolesAsync(Ct),
			"ListRoleMembers" => await api.ListRoleMembersAsync(roleId, Ct),
			_ => throw new ArgumentOutOfRangeException(nameof(read), read, "Unknown read."),
		};

		return result;
	}

	/// <summary>A read the stub keeps waiting, so a write can run while Auth0 hasn't answered it yet.</summary>
	private sealed class HeldRead
	{
		private readonly TaskCompletionSource _arrived = new(TaskCreationOptions.RunContinuationsAsynchronously);
		private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);

		public Task Arrived => _arrived.Task;

		public Task Released => _released.Task;

		public void Arrive()
		{
			_arrived.TrySetResult();
		}

		public void Release()
		{
			_released.TrySetResult();
		}
	}

	/// <summary>
	///   The stubbed Tenant behind <c>AddManagementApi()</c>: answers every endpoint the cache sits in front of with a
	///   success, with Auth0's 429 while <see cref="Failing" /> is set, or with a dropped connection while
	///   <see cref="Throwing" /> is set.
	/// </summary>
	private sealed class Scenario : IDisposable
	{
		private readonly ManagementApiHarness _harness;

		public Scenario(HarnessOptions? options = null)
		{
			_harness = ManagementApiHarness.Create(options);
			_harness.Handler.Responder = async (request, _) =>
			{
				// Only the first read after HoldNextRead() waits, so the write that races it isn't held up too.
				HeldRead? held = Interlocked.Exchange(ref _held, null);

				if (held is not null && request.Method == HttpMethod.Get)
				{
					held.Arrive();
					await held.Released;
				}

				if (Throwing)
				{
					throw new HttpRequestException("The connection dropped.");
				}

				return Failing ? RateLimited() : Serve(request);
			};
		}

		private HeldRead? _held;

		public bool Failing { get; set; }

		/// <summary>Makes every request fail with an <see cref="HttpRequestException" /> instead of an answer.</summary>
		public bool Throwing { get; set; }

		/// <summary>Makes the next read that reaches Auth0 wait until the returned <see cref="HeldRead" /> is released.</summary>
		public HeldRead HoldNextRead()
		{
			HeldRead held = new();
			_held = held;

			return held;
		}

		public IManagementApi Api => _harness.Api;

		public int RequestCount => _harness.Handler.ManagementRequests.Count;

		public void Advance(TimeSpan time)
		{
			_harness.Time.Advance(time);
		}

		/// <summary>Runs <paramref name="action" /> and says whether it sent any request to Auth0.</summary>
		public async Task<bool> ReachesAuth0Async(Func<Task> action)
		{
			int before = RequestCount;
			await action();

			return RequestCount > before;
		}

		public void Dispose()
		{
			_harness.Dispose();
		}

		private static HttpResponseMessage RateLimited()
		{
			return Auth0Responses.RateLimited(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1);
		}

		private static HttpResponseMessage Serve(RecordedRequest request)
		{
			string path = request.Path;
			bool read = request.Method == HttpMethod.Get;

			if (path == "/api/v2/users")
			{
				return Auth0Responses.Json(Auth0Responses.UsersPage(3, "auth0|1", "auth0|2", "auth0|3"));
			}

			if (path == "/api/v2/roles")
			{
				return read
					? Auth0Responses.RolesPage(request, ["rol_admin", "rol_user"])
					: Auth0Responses.Json("""{"id":"rol_new","name":"Editor","description":"Edits things"}""");
			}

			if (path.StartsWith("/api/v2/roles/", StringComparison.Ordinal) && path.EndsWith("/users", StringComparison.Ordinal))
			{
				return Auth0Responses.RoleUsersPage(["auth0|1", "auth0|2", "auth0|3"], null);
			}

			if (path.EndsWith("/roles", StringComparison.Ordinal))
			{
				return read ? Auth0Responses.RolesPage(request, ["rol_admin"]) : Auth0Responses.NoContent();
			}

			string id = path["/api/v2/users/".Length..];

			return Auth0Responses.Json(Auth0Responses.User(id));
		}
	}

	[Fact]
	public void IManagementApi_Resolved_IsTheCachedDecoratorRegisteredAsOneSingleton()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServiceCollection services = new();
		services.AddManagementApi();

		// Act
		IManagementApi first = harness.Api;
		IManagementApi second = harness.Api;
		ServiceDescriptor descriptor = services.Single(registered => registered.ServiceType == typeof(IManagementApi));

		// Assert
		first.GetType().Name.Should().Be("CachedManagementApi");
		second.Should().BeSameAs(first);
		descriptor.Lifetime.Should().Be(ServiceLifetime.Singleton, "the cache holds Tenant data, which is the same for every Admin");
	}

	[Fact]
	public async Task ReadAsync_AddManagementApiRanTwice_StillCachesThroughOneDecorator()
	{
		// Arrange
		using Scenario scenario = new(new HarnessOptions { RegisterTwice = true });
		await scenario.Api.GetUserAsync(ApiCalls.UserId, Ct);
		int afterFirstRead = scenario.RequestCount;

		// Act
		await scenario.Api.GetUserAsync(ApiCalls.UserId, Ct);

		// Assert
		scenario.Api.GetType().Name.Should().Be("CachedManagementApi");
		afterFirstRead.Should().BePositive();
		scenario.RequestCount.Should().Be(afterFirstRead, "the second read is served from the cache");
	}

	[Fact]
	public async Task SearchUsersAsync_ThousandDistinctPages_AllStayCachedBecauseEachEntryHasSizeOne()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 5000);
		using Scenario scenario = new(new HarnessOptions { Limiter = limiter });

		for (int i = 0; i < 1000; i++)
		{
			await scenario.Api.SearchUsersAsync(new UserSearch($"user{i}", 1, 1), Ct);
		}

		// Act
		int requestsBefore = scenario.RequestCount;
		for (int i = 0; i < 1000; i++)
		{
			await scenario.Api.SearchUsersAsync(new UserSearch($"user{i}", 1, 1), Ct);
		}

		// Assert
		requestsBefore.Should().Be(1000);
		scenario.RequestCount.Should().Be(1000, "the cache's SizeLimit is 1000 and each entry has size 1, so 1000 entries fit");
	}

	[Fact]
	public async Task SearchUsersAsync_ThousandAndFirstDistinctPage_IsRefusedBySizeLimit()
	{
		// Arrange
		using TokenBucketRateLimiter limiter = ManagementApiHarness.ManualLimiter(tokenLimit: 5000);
		using Scenario scenario = new(new HarnessOptions { Limiter = limiter });

		for (int i = 0; i < 1000; i++)
		{
			await scenario.Api.SearchUsersAsync(new UserSearch($"user{i}", 1, 1), Ct);
		}

		await scenario.Api.SearchUsersAsync(new UserSearch("one-too-many", 1, 1), Ct);
		int requestsBefore = scenario.RequestCount;

		// Act
		await scenario.Api.SearchUsersAsync(new UserSearch("one-too-many", 1, 1), Ct);

		// Assert
		scenario.RequestCount.Should().Be(requestsBefore + 1, "a full cache refuses the entry that doesn't fit, so the next read asks Auth0 again");
	}

	[Theory]
	[MemberData(nameof(CachedReads))]
	public async Task ReadAsync_FirstCallFailsWith429_TheNextCallRequestsAgainAndSucceeds(string read)
	{
		// Arrange
		using Scenario scenario = new() { Failing = true };
		Result failed = await ReadAsync(scenario.Api, read);
		scenario.Failing = false;

		// Act
		bool secondReachedAuth0 = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, read));
		Result succeeded = await ReadAsync(scenario.Api, read);

		// Assert
		failed.Success.Should().BeFalse();
		failed.Details.Should().Be("ManagementApi.RateLimited");
		secondReachedAuth0.Should().BeTrue("a failed Result, a 429 included, is never cached");
		succeeded.Success.Should().BeTrue();
	}

	[Theory]
	[InlineData("SearchUsers", HttpStatusCode.BadRequest, "Invalid query", "User.SearchInvalid")]
	[InlineData("GetUser", HttpStatusCode.NotFound, "The user does not exist.", "User.NotFound")]
	[InlineData("ListRoleMembers", HttpStatusCode.NotFound, "The role does not exist.", "Role.NotFound")]
	public async Task ReadAsync_FirstCallFailsWithACataloguedError_TheNextCallRequestsAgain(
		string read, HttpStatusCode status, string message, string expectedCode)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError(status, message);
		Result first = await ReadAsync(harness.Api, read);
		int afterFirstRead = harness.Handler.ManagementRequests.Count;

		// Act
		Result second = await ReadAsync(harness.Api, read);

		// Assert
		first.Details.Should().Be(expectedCode);
		second.Details.Should().Be(expectedCode);
		harness.Handler.ManagementRequests.Count.Should().BeGreaterThan(afterFirstRead, "a failed Result is never cached");
	}

	[Theory]
	[MemberData(nameof(ReadLifetimes))]
	public async Task ReadAsync_SecondIdenticalReadWithinItsLifetime_SendsNoSecondRequest(string read, int lifetimeSeconds)
	{
		// Arrange
		using Scenario scenario = new();
		Result first = await ReadAsync(scenario.Api, read);
		int afterFirstRead = scenario.RequestCount;
		scenario.Advance(TimeSpan.FromSeconds(lifetimeSeconds - 1));

		// Act
		Result second = await ReadAsync(scenario.Api, read);

		// Assert
		first.Success.Should().BeTrue();
		second.Success.Should().BeTrue();
		afterFirstRead.Should().BePositive();
		scenario.RequestCount.Should().Be(afterFirstRead);
	}

	[Theory]
	[MemberData(nameof(ReadLifetimes))]
	public async Task ReadAsync_ReadAfterItsLifetime_SendsTheRequestsAgain(string read, int lifetimeSeconds)
	{
		// Arrange
		using Scenario scenario = new();
		await ReadAsync(scenario.Api, read);
		int afterFirstRead = scenario.RequestCount;
		scenario.Advance(TimeSpan.FromSeconds(lifetimeSeconds + 1));

		// Act
		Result second = await ReadAsync(scenario.Api, read);

		// Assert
		second.Success.Should().BeTrue();
		scenario.RequestCount.Should().Be(afterFirstRead * 2, "the entry expired, so the read repeats exactly the first read's requests");
	}

	[Fact]
	public async Task ReadAsync_ReadAtEachLifetime_ExpiresEachEntryOnItsOwnClock()
	{
		// Arrange
		using Scenario scenario = new();
		await ReadAsync(scenario.Api, "SearchUsers");
		await ReadAsync(scenario.Api, "GetUser");
		await ReadAsync(scenario.Api, "ListRoles");
		await ReadAsync(scenario.Api, "ListRoleMembers");
		scenario.Advance(TimeSpan.FromSeconds(61));

		// Act
		bool searchReached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, "SearchUsers"));
		bool userReached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, "GetUser"));
		bool rolesReached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, "ListRoles"));
		bool membersReached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, "ListRoleMembers"));

		// Assert
		searchReached.Should().BeTrue("a search page lives 30 s");
		userReached.Should().BeTrue("a User lives 60 s");
		rolesReached.Should().BeFalse("the Role list lives 5 min");
		membersReached.Should().BeTrue("a Role's members live 60 s");
	}

	[Fact]
	public async Task SearchUsersAsync_QueryDiffersOnlyInOuterWhitespace_SharesOneEntry()
	{
		// Arrange
		using Scenario scenario = new();
		await scenario.Api.SearchUsersAsync(new UserSearch("  jane ", 1, 25), Ct);
		int afterFirstRead = scenario.RequestCount;

		// Act
		await scenario.Api.SearchUsersAsync(new UserSearch("jane", 1, 25), Ct);

		// Assert
		scenario.RequestCount.Should().Be(afterFirstRead, "the key is the trimmed query");
	}

	[Theory]
	[InlineData("name:a OR name:b", "name:a or name:b")]
	[InlineData("user_id:\"auth0|AbC\"", "user_id:\"auth0|abc\"")]
	public async Task SearchUsersAsync_QueryDiffersInCase_UsesAnotherEntry(string first, string second)
	{
		// Arrange
		using Scenario scenario = new();
		await scenario.Api.SearchUsersAsync(new UserSearch(first, 1, 25), Ct);

		// Act
		bool reached = await scenario.ReachesAuth0Async(async () => await scenario.Api.SearchUsersAsync(new UserSearch(second, 1, 25), Ct));

		// Assert
		reached.Should().BeTrue("Lucene reads these two queries differently, so one mustn't be answered with the other's page");
	}

	[Theory]
	[InlineData("GetUser", "UpdateProfileFields")]
	[InlineData("GetUser", "AssignRole")]
	[InlineData("GetUser", "RemoveRole")]
	[InlineData("ListRoleMembers", "AssignRole")]
	[InlineData("ListRoleMembers", "RemoveRole")]
	[InlineData("ListRoles", "CreateRole")]
	[InlineData("SearchUsers", "UpdateProfileFields")]
	[InlineData("ListRoleMembers", "UpdateProfileFields")]
	public async Task ReadAsync_WriteEvictsItsEntryWhileTheReadIsInFlight_DoesNotCacheTheRead(string read, string write)
	{
		// Arrange
		using Scenario scenario = new();
		HeldRead held = scenario.HoldNextRead();
		Task<Result> inFlight = ReadAsync(scenario.Api, read);
		await held.Arrived;
		await ApiCalls.InvokeAsync(scenario.Api, write, Ct);

		// Act
		held.Release();
		await inFlight;
		bool reached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, read));

		// Assert
		reached.Should().BeTrue("Auth0 answered the read before the write landed, so its result mustn't be cached");
	}

	[Theory]
	[InlineData("jane", 2, 25)]
	[InlineData("jane", 1, 50)]
	[InlineData("john", 1, 25)]
	public async Task SearchUsersAsync_QueryPageOrPageSizeDiffers_UsesAnotherEntry(string query, int page, int perPage)
	{
		// Arrange
		using Scenario scenario = new();
		await scenario.Api.SearchUsersAsync(new UserSearch("jane", 1, 25), Ct);

		// Act
		bool reached = await scenario.ReachesAuth0Async(async () => await scenario.Api.SearchUsersAsync(new UserSearch(query, page, perPage), Ct));

		// Assert
		reached.Should().BeTrue("the key is the normalized query, the page and the page size");
	}

	[Fact]
	public async Task GetUserAsync_AnotherUserId_UsesAnotherEntry()
	{
		// Arrange
		using Scenario scenario = new();
		await scenario.Api.GetUserAsync(ApiCalls.UserId, Ct);

		// Act
		bool reached = await scenario.ReachesAuth0Async(async () => await scenario.Api.GetUserAsync(OtherUserId, Ct));

		// Assert
		reached.Should().BeTrue("a User is cached by id");
	}

	[Fact]
	public async Task ListRoleMembersAsync_AnotherRoleId_UsesAnotherEntry()
	{
		// Arrange
		using Scenario scenario = new();
		await scenario.Api.ListRoleMembersAsync(ApiCalls.RoleId, Ct);

		// Act
		bool reached = await scenario.ReachesAuth0Async(async () => await scenario.Api.ListRoleMembersAsync(OtherRoleId, Ct));

		// Assert
		reached.Should().BeTrue("a Role's members are cached by Role id");
	}

	[Theory]
	[MemberData(nameof(UncachedCalls))]
	public async Task Call_CountHoldsOrWrite_AlwaysReachesAuth0EvenWithTheReadsCached(string call)
	{
		// Arrange
		using Scenario scenario = new();
		await scenario.Api.ListRoleMembersAsync(ApiCalls.RoleId, Ct);
		await scenario.Api.GetUserAsync(ApiCalls.UserId, Ct);
		await scenario.Api.ListRolesAsync(Ct);

		// Act
		bool firstReached = await scenario.ReachesAuth0Async(async () => await ApiCalls.InvokeAsync(scenario.Api, call, Ct));
		bool secondReached = await scenario.ReachesAuth0Async(async () => await ApiCalls.InvokeAsync(scenario.Api, call, Ct));

		// Assert
		firstReached.Should().BeTrue();
		secondReached.Should().BeTrue("this call is never served from the cache");
	}

	/// <summary>Reads two Users, two search pages, two Roles' members and the Role list, so a write's evictions show.</summary>
	private static async Task PrimeAsync(Scenario scenario)
	{
		await scenario.Api.GetUserAsync(ApiCalls.UserId, Ct);
		await scenario.Api.GetUserAsync(OtherUserId, Ct);
		await scenario.Api.SearchUsersAsync(new UserSearch("jane", 1, 25), Ct);
		await scenario.Api.SearchUsersAsync(new UserSearch("john", 2, 50), Ct);
		await scenario.Api.ListRoleMembersAsync(ApiCalls.RoleId, Ct);
		await scenario.Api.ListRoleMembersAsync(OtherRoleId, Ct);
		await scenario.Api.ListRolesAsync(Ct);
	}

	private sealed record Evicted(
		bool User,
		bool OtherUser,
		bool FirstSearchPage,
		bool SecondSearchPage,
		bool Members,
		bool OtherMembers,
		bool Roles);

	private static async Task<Evicted> WhatReachesAuth0Async(Scenario scenario)
	{
		return new Evicted(
			await scenario.ReachesAuth0Async(async () => await scenario.Api.GetUserAsync(ApiCalls.UserId, Ct)),
			await scenario.ReachesAuth0Async(async () => await scenario.Api.GetUserAsync(OtherUserId, Ct)),
			await scenario.ReachesAuth0Async(async () => await scenario.Api.SearchUsersAsync(new UserSearch("jane", 1, 25), Ct)),
			await scenario.ReachesAuth0Async(async () => await scenario.Api.SearchUsersAsync(new UserSearch("john", 2, 50), Ct)),
			await scenario.ReachesAuth0Async(async () => await scenario.Api.ListRoleMembersAsync(ApiCalls.RoleId, Ct)),
			await scenario.ReachesAuth0Async(async () => await scenario.Api.ListRoleMembersAsync(OtherRoleId, Ct)),
			await scenario.ReachesAuth0Async(async () => await scenario.Api.ListRolesAsync(Ct)));
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_Saved_EvictsThatUserEverySearchPageAndEveryRolesMembers()
	{
		// Arrange
		using Scenario scenario = new();
		await PrimeAsync(scenario);

		// Act
		Result saved = await scenario.Api.UpdateProfileFieldsAsync(ApiCalls.UserId, new ProfileFieldsChange(Nickname: "jd"), Ct);
		Evicted evicted = await WhatReachesAuth0Async(scenario);

		// Assert
		saved.Success.Should().BeTrue();
		evicted.Should().Be(new Evicted(
			User: true,
			OtherUser: false,
			FirstSearchPage: true,
			SecondSearchPage: true,
			Members: true,
			OtherMembers: true,
			Roles: false));
	}

	[Theory]
	[InlineData("AssignRole")]
	[InlineData("RemoveRole")]
	public async Task RoleWrite_AssignedOrRemoved_EvictsThatUserAndThatRolesMembersOnly(string call)
	{
		// Arrange
		using Scenario scenario = new();
		await PrimeAsync(scenario);

		// Act
		Result written = call == "AssignRole"
			? await scenario.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Ct)
			: await scenario.Api.RemoveRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Ct);
		Evicted evicted = await WhatReachesAuth0Async(scenario);

		// Assert
		written.Success.Should().BeTrue();
		evicted.Should().Be(new Evicted(
			User: true,
			OtherUser: false,
			FirstSearchPage: false,
			SecondSearchPage: false,
			Members: true,
			OtherMembers: false,
			Roles: false));
	}

	[Theory]
	[InlineData("UpdateProfileFields", "GetUser")]
	[InlineData("UpdateProfileFields", "SearchUsers")]
	[InlineData("UpdateProfileFields", "ListRoleMembers")]
	[InlineData("AssignRole", "GetUser")]
	[InlineData("AssignRole", "ListRoleMembers")]
	[InlineData("RemoveRole", "GetUser")]
	[InlineData("RemoveRole", "ListRoleMembers")]
	[InlineData("CreateRole", "ListRoles")]
	public async Task Write_FailsWith429_StillEvictsTheEntriesItMakesStale(string write, string read)
	{
		// Arrange
		using Scenario scenario = new();
		await ReadAsync(scenario.Api, read);

		// Act
		scenario.Failing = true;
		Result written = await ApiCalls.InvokeAsync(scenario.Api, write, Ct);
		scenario.Failing = false;
		bool reached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, read));

		// Assert
		written.Success.Should().BeFalse();
		reached.Should().BeTrue("a write that failed may still have reached Auth0, so the entries it makes stale are dropped anyway");
	}

	[Theory]
	[InlineData("UpdateProfileFields", "GetUser")]
	[InlineData("UpdateProfileFields", "SearchUsers")]
	[InlineData("UpdateProfileFields", "ListRoleMembers")]
	[InlineData("AssignRole", "GetUser")]
	[InlineData("AssignRole", "ListRoleMembers")]
	[InlineData("RemoveRole", "GetUser")]
	[InlineData("RemoveRole", "ListRoleMembers")]
	[InlineData("CreateRole", "ListRoles")]
	public async Task Write_Throws_StillEvictsTheEntriesItMakesStale(string write, string read)
	{
		// Arrange
		using Scenario scenario = new();
		await ReadAsync(scenario.Api, read);
		scenario.Throwing = true;

		// Act
		Func<Task> act = async () => await ApiCalls.InvokeAsync(scenario.Api, write, Ct);
		await act.Should().ThrowAsync<Exception>();
		scenario.Throwing = false;
		bool reached = await scenario.ReachesAuth0Async(async () => await ReadAsync(scenario.Api, read));

		// Assert
		reached.Should().BeTrue("a write that threw may still have reached Auth0, so the entries it makes stale are dropped anyway");
	}

	[Fact]
	public async Task CreateRoleAsync_Created_EvictsTheRoleListOnly()
	{
		// Arrange
		using Scenario scenario = new();
		await PrimeAsync(scenario);

		// Act
		Result<RoleSummary> created = await scenario.Api.CreateRoleAsync(new NewRole("Editor", "Edits things"), Ct);
		Evicted evicted = await WhatReachesAuth0Async(scenario);

		// Assert
		created.Success.Should().BeTrue();
		evicted.Should().Be(new Evicted(
			User: false,
			OtherUser: false,
			FirstSearchPage: false,
			SecondSearchPage: false,
			Members: false,
			OtherMembers: false,
			Roles: true));
	}
}
