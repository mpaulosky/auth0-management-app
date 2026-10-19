// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RoleMembersTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Net;

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class RoleMembersTests
{
	private const string MembersPath = "/api/v2/roles/rol_admin/users";
	private const string UserRolesPath = "/api/v2/users/auth0|abc/roles";

	/// <summary>
	///   Answers the members endpoint with checkpoint pages of 100 Users: <paramref name="pageSizes" /> gives each page's
	///   size, and every page but the last carries a <c>next</c> token <c>cN</c>.
	/// </summary>
	private static void ServeMembers(StubAuth0Handler handler, params int[] pageSizes)
	{
		handler.Respond(request =>
		{
			request.Path.Should().Be(MembersPath);
			string? from = request.Query["from"];
			int index = from is null ? 0 : int.Parse(from[1..], System.Globalization.CultureInfo.InvariantCulture);
			string? next = index + 1 < pageSizes.Length ? $"c{index + 1}" : null;
			IEnumerable<string> ids = Enumerable.Range(0, pageSizes[index]).Select(i => $"auth0|p{index}-{i}");

			return Auth0Responses.RoleUsersPage(ids, next);
		});
	}

	[Fact]
	public async Task ListRoleMembersAsync_ThreePages_FollowsCheckpointPagingHundredAtATime()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServeMembers(harness.Handler, 100, 100, 30);

		// Act
		Result<RoleMembers> result = await harness.Api.ListRoleMembersAsync(ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		RoleMembers members = ApiCalls.ValueOf(result);
		members.Users.Should().HaveCount(230);
		members.Truncated.Should().BeFalse();
		members.Users.Select(user => user.Id).Should().OnlyHaveUniqueItems();
		members.Users[0].Name.Should().Be("Name auth0|p0-0");
		members.Users[0].Email.Should().Be("auth0-p0-0@example.test");
		IReadOnlyList<RecordedRequest> requests = harness.Handler.ManagementRequests;
		requests.Should().HaveCount(3);
		requests.Should().OnlyContain(request => request.Method == HttpMethod.Get && request.Query["take"] == "100");
		requests.Select(request => request.Query["from"]).Should().Equal(null, "c1", "c2");
	}

	[Fact]
	public async Task ListRoleMembersAsync_MoreThanAThousandMembers_StopsAtAThousandAndSaysTruncated()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServeMembers(harness.Handler, [.. Enumerable.Repeat(100, 12)]);

		// Act
		Result<RoleMembers> result = await harness.Api.ListRoleMembersAsync(ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		RoleMembers members = ApiCalls.ValueOf(result);
		members.Users.Should().HaveCount(1000);
		members.Truncated.Should().BeTrue();
		harness.Handler.ManagementRequests.Should().HaveCount(10, "1000 members is ten checkpoint pages");
	}

	[Fact]
	public async Task ListRoleMembersAsync_ExactlyAThousandMembers_IsNotTruncated()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServeMembers(harness.Handler, [.. Enumerable.Repeat(100, 10)]);

		// Act
		Result<RoleMembers> result = await harness.Api.ListRoleMembersAsync(ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		RoleMembers members = ApiCalls.ValueOf(result);
		members.Users.Should().HaveCount(1000);
		members.Truncated.Should().BeFalse();
	}

	[Fact]
	public async Task ListRoleMembersAsync_RoleWithNoMembers_ReturnsAnEmptyList()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.RoleUsersPage([], null));

		// Act
		Result<RoleMembers> result = await harness.Api.ListRoleMembersAsync(ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		RoleMembers members = ApiCalls.ValueOf(result);
		members.Users.Should().BeEmpty();
		members.Truncated.Should().BeFalse();
	}

	[Fact]
	public async Task ListRoleMembersAsync_RateLimitedOnTheSecondPage_FailsTheWholeCallAndReturnsNoPartialList()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		long resetSoon = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
		harness.Handler.Respond(request => request.Query["from"] is null
			? Auth0Responses.RoleUsersPage(Enumerable.Range(0, 100).Select(i => $"auth0|p0-{i}"), "c1")
			: Auth0Responses.RateLimited(resetSoon));

		// Act
		Result<RoleMembers> result = await harness.Api.ListRoleMembersAsync(ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		result.Value.Should().BeNull("a partial membership is never returned");
	}

	[Fact]
	public async Task CountRoleMembersAsync_AtMostReachedOnTheFirstPage_StopsRequesting()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServeMembers(harness.Handler, [.. Enumerable.Repeat(100, 12)]);

		// Act
		Result<int> result = await harness.Api.CountRoleMembersAsync(ApiCalls.RoleId, 2, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().Be(2);
		harness.Handler.ManagementRequests.Should().HaveCount(1);
	}

	[Fact]
	public async Task CountRoleMembersAsync_AtMostReachedOnTheSecondPage_StopsAfterThatPage()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServeMembers(harness.Handler, [.. Enumerable.Repeat(100, 12)]);

		// Act
		Result<int> result = await harness.Api.CountRoleMembersAsync(ApiCalls.RoleId, 150, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().Be(150, "the count is min(members, atMost)");
		harness.Handler.ManagementRequests.Should().HaveCount(2);
	}

	[Fact]
	public async Task CountRoleMembersAsync_FewerMembersThanAtMost_CountsThemAll()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		ServeMembers(harness.Handler, 100, 30);

		// Act
		Result<int> result = await harness.Api.CountRoleMembersAsync(ApiCalls.RoleId, 500, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().Be(130);
		harness.Handler.ManagementRequests.Should().HaveCount(2);
	}

	[Fact]
	public async Task CountRoleMembersAsync_RoleWithNoMembers_ReturnsZero()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.RoleUsersPage([], null));

		// Act
		Result<int> result = await harness.Api.CountRoleMembersAsync(ApiCalls.RoleId, 2, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().Be(0);
	}

	[Fact]
	public async Task UserHoldsRoleAsync_RoleOnTheSecondPageOfTheUsersRoles_ReturnsTrue()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request =>
		{
			request.Path.Should().Be(UserRolesPath);

			return Auth0Responses.RolesPage(request, ["rol_a", "rol_b"], ["rol_c", "rol_admin"]);
		});

		// Act
		Result<bool> result = await harness.Api.UserHoldsRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().BeTrue();
		harness.Handler.ManagementRequests.Select(request => request.Query["page"]).Should().Contain("1");
	}

	[Fact]
	public async Task UserHoldsRoleAsync_RoleNotAmongTheUsersRoles_ReturnsFalseAfterPagingThroughAllOfThem()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request => Auth0Responses.RolesPage(request, ["rol_a", "rol_b"], ["rol_c", "rol_d"]));

		// Act
		Result<bool> result = await harness.Api.UserHoldsRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().BeFalse();
		harness.Handler.ManagementRequests.Select(request => request.Query["page"]).Should().Contain("1");
	}

	[Fact]
	public async Task UserHoldsRoleAsync_UserWithNoRoles_ReturnsFalse()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request => Auth0Responses.RolesPage(request));

		// Act
		Result<bool> result = await harness.Api.UserHoldsRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().BeFalse();
	}
}
