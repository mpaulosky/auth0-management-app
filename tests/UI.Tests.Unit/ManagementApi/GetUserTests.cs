// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     GetUserTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class GetUserTests
{
	private const string ProfilePath = "/api/v2/users/auth0|abc";

	private static ManagementApiHarness HarnessFor(string userJson)
	{
		ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(request => request.Path switch
		{
			ProfilePath => Auth0Responses.Json(userJson),
			ProfilePath + "/roles" => Auth0Responses.RolesPage(request, ["rol_admin", "rol_user"]),
			_ => throw new InvalidOperationException($"Unexpected request {request.Method} {request.Path}"),
		});

		return harness;
	}

	[Fact]
	public async Task GetUserAsync_DatabaseUser_ReturnsProfileFieldsConnectionLastLoginAndRoles()
	{
		// Arrange
		using ManagementApiHarness harness = HarnessFor(Auth0Responses.User());

		// Act
		Result<UserDetails> result = await harness.Api.GetUserAsync(ApiCalls.UserId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		UserDetails user = ApiCalls.ValueOf(result);
		user.Id.Should().Be("auth0|abc");
		user.Name.Should().Be("Jane Doe");
		user.GivenName.Should().Be("Jane");
		user.FamilyName.Should().Be("Doe");
		user.Nickname.Should().Be("jd");
		user.Picture.Should().Be("https://example.test/jane.png");
		user.Email.Should().Be("jane@example.test");
		user.EmailVerified.Should().BeTrue();
		user.Connection.Should().Be("Username-Password-Authentication");
		user.LastLogin.Should().Be(new DateTimeOffset(2026, 10, 1, 12, 0, 0, TimeSpan.Zero));
		user.Roles.Select(role => role.Id).Should().Equal("rol_admin", "rol_user");
		user.Roles[0].Name.Should().Be("Role rol_admin");
		user.Roles[0].Description.Should().Be("About rol_admin");
	}

	[Fact]
	public async Task GetUserAsync_UserNeverSignedIn_ReturnsNoLastLogin()
	{
		// Arrange
		string json = Auth0Responses.User().Replace("\"last_login\": \"2026-10-01T12:00:00.000Z\",", string.Empty, StringComparison.Ordinal);
		using ManagementApiHarness harness = HarnessFor(json);

		// Act
		Result<UserDetails> result = await harness.Api.GetUserAsync(ApiCalls.UserId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ApiCalls.ValueOf(result).LastLogin.Should().BeNull();
	}

	public static TheoryData<string, string, ProfileField> EditableFieldsByConnection => new()
	{
		{ "Username-Password-Authentication", "auth0", ProfileField.Name | ProfileField.GivenName | ProfileField.FamilyName | ProfileField.Nickname | ProfileField.Picture | ProfileField.Email },
		{ "email", "email", ProfileField.Name | ProfileField.GivenName | ProfileField.FamilyName | ProfileField.Nickname | ProfileField.Picture },
		{ "sms", "sms", ProfileField.Name | ProfileField.GivenName | ProfileField.FamilyName | ProfileField.Nickname | ProfileField.Picture },
		{ "google-oauth2", "google-oauth2", ProfileField.None },
		{ "facebook", "facebook", ProfileField.None },
		{ "corp-saml", "samlp", ProfileField.None },
		{ "corp-azure-ad", "waad", ProfileField.None },
		{ "corp-adfs", "adfs", ProfileField.None },
		{ "corp-oidc", "oidc", ProfileField.None },
	};

	[Theory]
	[MemberData(nameof(EditableFieldsByConnection))]
	public async Task GetUserAsync_ConnectionType_ComputesEditableFields(string connection, string provider, ProfileField expected)
	{
		// Arrange
		bool isSocial = provider is "google-oauth2" or "facebook";
		using ManagementApiHarness harness = HarnessFor(Auth0Responses.User(connection: connection, provider: provider, isSocial: isSocial));

		// Act
		Result<UserDetails> result = await harness.Api.GetUserAsync(ApiCalls.UserId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		UserDetails user = ApiCalls.ValueOf(result);
		user.Connection.Should().Be(connection);
		user.EditableFields.Should().Be(expected);
	}
}
