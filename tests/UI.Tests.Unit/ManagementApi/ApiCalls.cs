// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ApiCalls.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Net;

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

/// <summary>
///   Calls each <see cref="IManagementApi" /> method by name, so a theory can run one case against every use case.
/// </summary>
internal static class ApiCalls
{
	public const string UserId = "auth0|abc";
	public const string RoleId = "rol_admin";

	public static TheoryData<string> All =>
	[
		"SearchUsers", "GetUser", "UpdateProfileFields", "AssignRole", "RemoveRole", "ListRoles", "CreateRole",
		"ListRoleMembers", "CountRoleMembers", "UserHoldsRole",
	];

	public static async Task<Result> InvokeAsync(IManagementApi api, string call, CancellationToken cancellationToken)
	{
		ArgumentNullException.ThrowIfNull(api);

		Result result = call switch
		{
			"SearchUsers" => await api.SearchUsersAsync(new UserSearch("name:ja*", 1, 25), cancellationToken),
			"GetUser" => await api.GetUserAsync(UserId, cancellationToken),
			"UpdateProfileFields" => await api.UpdateProfileFieldsAsync(UserId, new ProfileFieldsChange(Nickname: "jd"), cancellationToken),
			"AssignRole" => await api.AssignRoleAsync(UserId, RoleId, cancellationToken),
			"RemoveRole" => await api.RemoveRoleAsync(UserId, RoleId, cancellationToken),
			"ListRoles" => await api.ListRolesAsync(cancellationToken),
			"CreateRole" => await api.CreateRoleAsync(new NewRole("Editor", "Edits things"), cancellationToken),
			"ListRoleMembers" => await api.ListRoleMembersAsync(RoleId, cancellationToken),
			"CountRoleMembers" => await api.CountRoleMembersAsync(RoleId, 2, cancellationToken),
			"UserHoldsRole" => await api.UserHoldsRoleAsync(UserId, RoleId, cancellationToken),
			_ => throw new ArgumentOutOfRangeException(nameof(call), call, "Unknown call."),
		};

		return result;
	}

	/// <summary>
	///   Answers every <c>/api/v2/*</c> request with the same error.
	/// </summary>
	public static void RespondWithError(this StubAuth0Handler handler, HttpStatusCode status, string message)
	{
		ArgumentNullException.ThrowIfNull(handler);

		handler.Respond(_ => Auth0Responses.Error(status, message));
	}

	/// <summary>
	///   The value of a successful result, failing the test when the result failed.
	/// </summary>
	public static T ValueOf<T>(Result<T> result)
	{
		ArgumentNullException.ThrowIfNull(result);

		result.Success.Should().BeTrue("the call was expected to succeed, but failed with {0} ({1})", result.Details, result.Error);

		// The success assertion above guarantees the value is present, so the null-forgiving operator is safe here.
		return result.Value!;
	}
}
