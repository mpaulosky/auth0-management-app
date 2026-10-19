// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RoleCallsTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Text.Json;

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class RoleCallsTests
{
	[Fact]
	public async Task Calls_InSequence_ShareOneCachedToken()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request => request.Method == HttpMethod.Get
			? Auth0Responses.RolesPage(request, ["rol_admin"])
			: Auth0Responses.NoContent());

		// Act
		Result<IReadOnlyList<RoleSummary>> roles = await harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);
		Result assigned = await harness.Api.AssignRoleAsync(ApiCalls.UserId, "rol_admin", Xunit.TestContext.Current.CancellationToken);
		Result removed = await harness.Api.RemoveRoleAsync(ApiCalls.UserId, "rol_admin", Xunit.TestContext.Current.CancellationToken);

		// Assert
		roles.Success.Should().BeTrue();
		assigned.Success.Should().BeTrue();
		removed.Success.Should().BeTrue();
		harness.Handler.TokenRequestCount.Should().Be(1, "each call builds a new client, but the singleton provider keeps the token");
	}

	[Fact]
	public async Task AssignRoleAsync_UserAndRole_PostsTheRoleIdToTheUsersRoles()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.AssignRoleAsync(ApiCalls.UserId, "rol_editor", Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		RecordedRequest request = harness.Handler.ManagementRequests.Should().ContainSingle().Subject;
		request.Method.Should().Be(HttpMethod.Post);
		request.Path.Should().Be("/api/v2/users/auth0|abc/roles");
		JsonDocument.Parse(request.Body).RootElement.GetProperty("roles").EnumerateArray()
			.Select(role => role.GetString()).Should().Equal("rol_editor");
	}

	[Fact]
	public async Task RemoveRoleAsync_UserAndRole_DeletesTheRoleIdFromTheUsersRoles()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Result result = await harness.Api.RemoveRoleAsync(ApiCalls.UserId, "rol_editor", Xunit.TestContext.Current.CancellationToken);

		// Assert
		result.Success.Should().BeTrue();
		RecordedRequest request = harness.Handler.ManagementRequests.Should().ContainSingle().Subject;
		request.Method.Should().Be(HttpMethod.Delete);
		request.Path.Should().Be("/api/v2/users/auth0|abc/roles");
		JsonDocument.Parse(request.Body).RootElement.GetProperty("roles").EnumerateArray()
			.Select(role => role.GetString()).Should().Equal("rol_editor");
	}

	[Fact]
	public async Task ListRolesAsync_RolesOnTwoPages_ReturnsEveryRole()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request =>
		{
			request.Path.Should().Be("/api/v2/roles");

			return Auth0Responses.RolesPage(request, ["rol_admin", "rol_user"], ["rol_editor"]);
		});

		// Act
		Result<IReadOnlyList<RoleSummary>> result = await harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		IReadOnlyList<RoleSummary> roles = ApiCalls.ValueOf(result);
		roles.Select(role => role.Id).Should().Equal("rol_admin", "rol_user", "rol_editor");
		roles[0].Name.Should().Be("Role rol_admin");
		roles[0].Description.Should().Be("About rol_admin");
		harness.Handler.ManagementRequests.Should().OnlyContain(request => request.Method == HttpMethod.Get);
	}

	[Fact]
	public async Task ListRolesAsync_NoRoles_ReturnsAnEmptyList()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request => Auth0Responses.RolesPage(request));

		// Act
		Result<IReadOnlyList<RoleSummary>> result = await harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).Should().BeEmpty();
	}

	[Fact]
	public async Task CreateRoleAsync_NameAndDescription_PostsThemAndReturnsTheCreatedRole()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json("""{"id":"rol_new","name":"Editor","description":"Edits things"}"""));

		// Act
		Result<RoleSummary> result = await harness.Api.CreateRoleAsync(
			new NewRole("Editor", "Edits things"), Xunit.TestContext.Current.CancellationToken);

		// Assert
		RoleSummary role = ApiCalls.ValueOf(result);
		role.Should().Be(new RoleSummary("rol_new", "Editor", "Edits things"));
		RecordedRequest request = harness.Handler.ManagementRequests.Should().ContainSingle().Subject;
		request.Method.Should().Be(HttpMethod.Post);
		request.Path.Should().Be("/api/v2/roles");
		JsonElement body = JsonDocument.Parse(request.Body).RootElement;
		body.GetProperty("name").GetString().Should().Be("Editor");
		body.GetProperty("description").GetString().Should().Be("Edits things");
	}
}
