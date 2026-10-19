// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ErrorMappingTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Net;

using Domain.Abstractions;

namespace UI.Tests.Unit.ManagementApi;

public class ErrorMappingTests
{
	private const string UserMissing = "The user does not exist.";
	private const string RoleMissing = "The role does not exist.";

	public static TheoryData<string, int, string, string, ResultErrorCode> Catalogue => new()
	{
		{ "SearchUsers", 400, "Invalid query", "User.SearchInvalid", ResultErrorCode.Validation },
		{ "SearchUsers", 503, "Search timed out.", "User.SearchTooBroad", ResultErrorCode.Validation },
		{ "GetUser", 404, UserMissing, "User.NotFound", ResultErrorCode.NotFound },
		{ "UpdateProfileFields", 404, UserMissing, "User.NotFound", ResultErrorCode.NotFound },
		{ "UpdateProfileFields", 409, "The specified new email already exists.", "User.EmailInUse", ResultErrorCode.Conflict },
		{ "UpdateProfileFields", 400, "The following user attributes cannot be updated: nickname.", "User.FieldNotEditable", ResultErrorCode.Validation },
		{ "AssignRole", 404, UserMissing, "User.NotFound", ResultErrorCode.NotFound },
		{ "AssignRole", 404, RoleMissing, "Role.NotFound", ResultErrorCode.NotFound },
		{ "AssignRole", 404, "The following roles do not exist: rol_admin.", "Role.NotFound", ResultErrorCode.NotFound },
		{ "RemoveRole", 404, UserMissing, "User.NotFound", ResultErrorCode.NotFound },
		{ "RemoveRole", 404, RoleMissing, "Role.NotFound", ResultErrorCode.NotFound },
		{ "CreateRole", 409, "The role already exists.", "Role.AlreadyExists", ResultErrorCode.Conflict },
		{ "ListRoleMembers", 404, RoleMissing, "Role.NotFound", ResultErrorCode.NotFound },
		{ "CountRoleMembers", 404, RoleMissing, "Role.NotFound", ResultErrorCode.NotFound },
		{ "UserHoldsRole", 404, UserMissing, "User.NotFound", ResultErrorCode.NotFound },
	};

	[Theory]
	[MemberData(nameof(Catalogue))]
	public async Task Call_StatusInTheCatalogue_ReturnsItsCodeAndCategory(
		string call, int status, string message, string expectedCode, ResultErrorCode expectedCategory)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError((HttpStatusCode)status, message);

		// Act
		Result result = await ApiCalls.InvokeAsync(harness.Api, call, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse();
		result.Details.Should().Be(expectedCode);
		result.ErrorCode.Should().Be(expectedCategory);
		result.Error.Should().NotBeNullOrWhiteSpace("a failed Result carries a human-readable message");
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_Auth0Returns400_FieldNotEditableCarriesAuth0sMessage()
	{
		// Arrange
		const string message = "The following user attributes cannot be updated: nickname. The connection (google-oauth2) must have user profile sync disabled.";
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError(HttpStatusCode.BadRequest, message);

		// Act
		Result result = await harness.Api.UpdateProfileFieldsAsync(
			ApiCalls.UserId, new(Nickname: "jd"), Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Details.Should().Be("User.FieldNotEditable");
		result.Error.Should().Contain(message);
	}

	[Theory]
	[MemberData(nameof(ApiCalls.All), MemberType = typeof(ApiCalls))]
	public async Task Call_Auth0RefusesWith429_ReturnsRateLimitedFromEveryUseCase(string call)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		long resetSoon = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
		harness.Handler.Respond(_ => Auth0Responses.RateLimited(resetSoon));

		// Act
		Result result = await ApiCalls.InvokeAsync(harness.Api, call, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse();
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		harness.Handler.ManagementRequests.Should().HaveCount(2, "the SDK retries a 429 once before the call gives up");
	}

	[Fact]
	public async Task AssignRoleAsync_RateLimitedOnce_SucceedsOnTheRetry()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		long resetSoon = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
		int attempts = 0;
		harness.Handler.Respond(_ => Interlocked.Increment(ref attempts) == 1
			? Auth0Responses.RateLimited(resetSoon)
			: Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, ApiCalls.RoleId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
	}

	[Fact]
	public async Task ListRolesAsync_Auth0Returns5xxOnTheRetryAfterA429_ReturnsRateLimited()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		long resetSoon = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1;
		int attempts = 0;
		harness.Handler.Respond(_ => Interlocked.Increment(ref attempts) == 1
			? Auth0Responses.RateLimited(resetSoon)
			: Auth0Responses.Error(HttpStatusCode.InternalServerError, "Internal server error"));

		// Act
		Result result = await harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeFalse("a 5xx on a call that met a 429 is Auth0 shedding load, not an outage");
		result.ErrorCode.Should().Be(ResultErrorCode.RateLimited);
		result.Details.Should().Be("ManagementApi.RateLimited");
		harness.Handler.ManagementRequests.Should().HaveCount(2);
	}

	[Theory]
	[InlineData("GetUser", 400)]
	[InlineData("ListRoles", 400)]
	[InlineData("AssignRole", 400)]
	[InlineData("SearchUsers", 500)]
	[InlineData("GetUser", 503)]
	[InlineData("UpdateProfileFields", 503)]
	public async Task Call_StatusNotInTheCatalogue_Throws(string call, int status)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError((HttpStatusCode)status, "Something Auth0 says.");

		// Act
		Func<Task> act = () => ApiCalls.InvokeAsync(harness.Api, call, Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>("anything the catalogue doesn't list is a bug or an outage, not an expected failure");
	}
}
